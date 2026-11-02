"""Workspace-scoped hybrid retrieval with live source verification and bounded output."""
from __future__ import annotations

from collections import defaultdict
import json
from pathlib import PureWindowsPath
import re
import time
from typing import Callable

from .embeddings import EmbeddingProvider
from .errors import CodeConvergeError
from .scanning import FilePolicy, read_source
from .settings import Settings
from .storage import ProjectIndex, lexical_text
from .workspace import Scope

STOP_WORDS = set("a an the to of for from in on by with and or is are be that this which where how what code find responsible does do can my me use using through when then returns return".split())
MODES = {"auto", "hybrid", "lexical", "semantic", "symbol"}


def validate(query, top_k, mode, paths, languages):
    if not isinstance(query, str) or not query.strip() or len(query) > 8192:
        raise CodeConvergeError("INVALID_QUERY", "Supply a nonempty query of at most 8192 characters.")
    if type(top_k) is not int or not 1 <= top_k <= 50 or mode not in MODES:
        raise CodeConvergeError("INVALID_QUERY", "Use top_k 1..50 and mode auto, hybrid, lexical, semantic or symbol.")
    if paths is None:
        paths = []
    if languages is None:
        languages = []
    for value in (paths, languages):
        if not isinstance(value, list) or len(value) > 32 or any(not isinstance(v, str) or not v or len(v) > 512 for v in value):
            raise CodeConvergeError("INVALID_FILTER", "Filters must be lists of at most 32 nonempty strings.")
    patterns = []
    for value in paths:
        path = PureWindowsPath(value)
        if path.is_absolute() or path.drive or ".." in path.parts or ":" in value or "\0" in value or value.startswith(("/", "\\")):
            raise CodeConvergeError("UNAUTHORIZED_PATH", "Path filters must be workspace-relative glob patterns.")
        normalized = value.replace("\\", "/").removeprefix("./")
        if normalized.endswith("/"):
            normalized += "*"
        patterns.append(normalized)
        if normalized.startswith("**/"):
            patterns.append(normalized[3:])
    aliases = {"js": "javascript", "ts": "typescript", "py": "python", "md": "markdown", "c#": "csharp"}
    languages = [aliases.get(value.casefold(), value.casefold()) for value in languages]
    if any(not re.fullmatch(r"[a-z0-9_+#-]{1,40}", language) for language in languages):
        raise CodeConvergeError("INVALID_FILTER", "Invalid language filter.")
    return query.strip(), patterns, languages


def lexical_query(query: str) -> str:
    terms = list(dict.fromkeys(word.casefold() for word in re.findall(r"[^\W_]+", lexical_text(query), re.UNICODE) if word.casefold() not in STOP_WORDS))[:48]
    if not terms:
        terms = re.findall(r"[^\W_]+", query, re.UNICODE)[:16]
    return " OR ".join('"' + word.replace('"', '""') + '"' for word in terms)


class Retriever:
    def __init__(self, embeddings: EmbeddingProvider, counter, settings: Settings):
        self.embeddings, self.counter, self.settings = embeddings, counter, settings

    def search(self, scope: Scope, indexes: dict[str, ProjectIndex], query: str, *, mode="auto", top_k=10,
               paths=None, languages=None, stale: Callable[[str, str], None] = lambda *_: None) -> dict:
        scope.require_roots()
        query, paths, languages = validate(query, top_k, mode, paths, languages)
        started = time.perf_counter()
        # Never iterate the manager's cached projects: this session's authority
        # is the complete list of eligible roots for every retrieval channel.
        eligible = [indexes[r.project_id] for r in scope.roots if r.project_id in indexes]
        channels = defaultdict(list)
        candidates = max(40, min(200, top_k * 8))
        symbol_query = query if mode == "symbol" or re.fullmatch(r"[\w.$:/<>-]{1,256}", query) else None
        if not symbol_query:
            quoted = re.findall(r"`([^`\n]{1,256})`", query)
            if len(quoted) == 1:
                symbol_query = quoted[0]
        match = lexical_query(query)
        for index in eligible:
            pid = index.root.project_id
            if mode in {"auto", "hybrid", "symbol"} and symbol_query:
                channels["symbol"].extend((pid, rowid, score) for rowid, score in index.symbols(symbol_query, candidates, paths, languages))
            if mode in {"auto", "hybrid", "lexical"} and match:
                channels["lexical"].extend((pid, rowid, score) for rowid, score in index.lexical(match, candidates, paths, languages))
        warnings = []
        exact = any(score >= 2 for _, _, score in channels["symbol"])
        semantic = mode in {"auto", "hybrid", "semantic"} and not (mode == "auto" and exact)
        counts = {i.root.project_id: i.counts() for i in eligible}
        if semantic and any(c["embedded_chunks"] for c in counts.values()):
            try:
                vector, clipped = self.embeddings.query(query, self.counter)
                if clipped:
                    warnings.append("Semantic query truncated to the configured token budget.")
                for index in eligible:
                    channels["semantic"].extend((index.root.project_id, rowid, score) for rowid, score in index.semantic(vector, candidates, paths, languages))
            except (OSError, RuntimeError, ValueError) as error:
                warnings.append(f"Semantic inference unavailable: {error}")
        elif semantic:
            warnings.append("No completed semantic vectors yet; lexical and symbol results are a partial-index fallback." if mode != "semantic" else "No completed semantic vectors yet.")
        partial = any(c["pending_chunks"] for c in counts.values()) or len(eligible) != len(scope.roots)
        if partial:
            warnings.append("Indexing is incomplete; only committed chunks are searchable.")
        fused = defaultdict(float)
        evidence = defaultdict(dict)
        for name, values in channels.items():
            values.sort(key=lambda value: (-value[2], value[0], value[1]))
            for rank, (pid, rowid, score) in enumerate(values, 1):
                key = pid, rowid
                fused[key] += (1.2 if name == "symbol" else 1) / (60 + rank)
                evidence[key][name] = {"rank": rank, "score": round(score, 6)}
        rows = {}
        for index in eligible:
            pid = index.root.project_id
            rows.update({(pid, key): value for key, value in index.rows([rowid for p, rowid in fused if p == pid]).items()})
        # Exact definitions and explicit path mentions receive small, stable
        # structural boosts. Learned/neural reranking is deliberately absent.
        for key, row in rows.items():
            if symbol_query and row["symbol"] and row["symbol"].casefold() == symbol_query.casefold():
                fused[key] += .012
            if row["path"].casefold() in query.casefold():
                fused[key] += .006
        results, live, fingerprints, spans, symbols = [], {}, set(), defaultdict(list), set()
        settings = self.settings.index
        used = 0
        stale_count = 0
        roots = {root.project_id: root for root in scope.roots}
        policies = {pid: FilePolicy(root, self.settings.files_for(root.path), (indexes[pid].paths.home,)) for pid, root in roots.items() if pid in indexes}
        for key in sorted(fused, key=lambda k: (-fused[k], k)):
            if key not in rows:
                continue
            pid, rowid = key
            row, root = rows[key], roots[pid]
            file_key = pid, row["path"]
            if file_key not in live:
                try:
                    live[file_key] = None if policies[pid].ignored(row["path"]) else read_source(root, row["path"], settings.max_file_bytes)
                except (OSError, CodeConvergeError):
                    live[file_key] = None
            source = live[file_key]
            if source is None or source.content_hash != row["file_hash"]:
                stale_count += 1
                stale(pid, row["path"])
                continue
            fingerprint = pid, row["content_hash"]
            definition = pid, row["path"], row["qualified_name"]
            if fingerprint in fingerprints or mode == "symbol" and row["qualified_name"] and definition in symbols:
                continue
            start, end = row["start_byte"], row["end_byte"]
            if any(max(0, min(end, b) - max(start, a)) > .7 * min(end - start, b - a) for a, b in spans[file_key]):
                continue
            # Excerpts are an original contiguous source span. Truncation never
            # invents lines or silently reports the full definition's end line.
            excerpt = "".join(row["text"].splitlines(keepends=True)[:settings.excerpt_lines])
            excerpt = excerpt[:settings.result_characters]
            if used + len(excerpt) > max(0, settings.output_characters - 1000 - 400 * (len(results) + 1)):
                break
            truncated = excerpt != row["text"]
            result = {"project_id": pid, "path": row["path"], "uri": (root.path / row["path"]).as_uri(),
                "symbol": row["qualified_name"], "language": row["language"], "kind": row["kind"],
                "start_line": row["start_line"], "end_line": row["start_line"] + excerpt.rstrip("\r\n").count("\n"),
                "excerpt": excerpt, "rank": len(results) + 1, "score": round(fused[key], 6), "matched_by": evidence[key]}
            if truncated:
                result.update(truncated=True, definition_end_line=row["end_line"])
            if row["start_column"]:
                result["start_column"] = row["start_column"]
            results.append(result)
            fingerprints.add(fingerprint)
            symbols.add(definition)
            spans[file_key].append((start, end))
            used += len(excerpt)
            if len(results) >= top_k:
                break
        if stale_count:
            warnings.append(f"Suppressed {stale_count} stale source candidates and scheduled synchronization.")
        result = {"mode": mode, "channels": [name for name, values in channels.items() if values],
            "partial": partial or bool(stale_count), "results": results, "warnings": warnings,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1)}
        # A strict encoded response ceiling, including metadata and paths.
        while result["results"] and len(json.dumps(result, ensure_ascii=False)) > settings.output_characters:
            result["results"].pop()
        return result
