"""Incremental lexical commits followed by resumable, content-cached embeddings."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import logging
import time
from typing import Callable

from .chunking import Chunker
from .database import utc_now
from .embeddings import EmbeddingProvider
from .errors import CodeConvergeError
from .scanning import FilePolicy, read_source
from .settings import Settings
from .storage import ProjectIndex, chunk_from_row


@dataclass
class SyncProgress:
    phase: str = "discovering"
    discovered: int = 0
    processed: int = 0
    changed_files: int = 0
    unchanged_files: int = 0
    removed_files: int = 0
    skipped_files: int = 0
    embedded_chunks: int = 0
    cache_hits: int = 0
    inferred_texts: int = 0
    tokens: int = 0
    seconds: float = 0
    cancelled: bool = False


class Synchronizer:
    def __init__(self, index: ProjectIndex, chunker: Chunker, embeddings: EmbeddingProvider, settings: Settings):
        self.index, self.chunker, self.embeddings, self.settings = index, chunker, embeddings, settings

    def run(self, *, paths: set[str] | None = None, verify: bool = True,
            cancelled: Callable[[], bool] = lambda: False, progress: Callable[[dict], None] = lambda _: None,
            max_embedding_batches: int | None = None) -> dict:
        started = time.perf_counter()
        status = SyncProgress()
        root = self.index.root
        policy = FilePolicy(root, self.settings.files_for(root.path), (self.index.paths.home,))
        previous = {} if paths == set() else self.index.files()
        # Ignore rule changes and directory notifications require discovery so
        # deleted/renamed trees and newly excluded descendants are reconciled.
        if paths is not None and any(p.endswith(".gitignore") or (root.path / p).is_dir() or not (root.path / p).exists() and p not in previous for p in paths):
            paths = None
        candidates = list(policy.discover()) if paths is None else sorted(paths)
        status.discovered = len(candidates)
        progress(asdict(status))
        seen = set()
        for relative in candidates:
            if cancelled():
                status.cancelled = True
                break
            seen.add(relative)
            old = previous.get(relative)
            try:
                if policy.ignored(relative):
                    if old:
                        self.index.remove_files([relative])
                        status.removed_files += 1
                    continue
                entry = (root.path / relative).stat()
                if not verify and old and old["parsing_identity"] == self.chunker.identity and (entry.st_size, entry.st_mtime_ns, f"{entry.st_dev}:{entry.st_ino}") == (old["size"], old["mtime_ns"], old["inode"]):
                    status.unchanged_files += 1
                    continue
                source = read_source(root, relative, self.settings.index.max_file_bytes)
                if old and source.content_hash == old["content_hash"] and old["parsing_identity"] == self.chunker.identity:
                    self.index.observed(source)
                    status.unchanged_files += 1
                else:
                    chunks = self.chunker.chunk(root.project_id, source)
                    self.index.replace_file(source, chunks, self.chunker.identity)
                    status.changed_files += 1
            except (OSError, CodeConvergeError) as error:
                status.skipped_files += 1
                # A racing save is retried by the debounce/reconciliation loop.
                if isinstance(error, CodeConvergeError) and error.code == "FILE_CHANGED":
                    continue
                if old:
                    self.index.remove_files([relative])
                    status.removed_files += 1
            finally:
                status.processed += 1
                if status.processed % 25 == 0:
                    progress(asdict(status))
        if not status.cancelled and paths is None:
            removed = sorted(set(previous) - seen)
            self.index.remove_files(removed)
            status.removed_files += len(removed)
        status.phase = "embedding"
        progress(asdict(status))
        batches = 0
        while not status.cancelled:
            if cancelled():
                status.cancelled = True
                break
            # Yield the shared model after each small batch. Interactive queries
            # have priority over the next background batch.
            pending = self.index.pending(self.settings.embedding.batch_sequences)
            if not pending:
                break
            # Hold the model for one native token batch, even when several large
            # chunks were fetched. This bounds foreground-query waiting and
            # cancellation latency instead of decoding multiple batches inside
            # one background inference turn.
            selected, texts, total_tokens = [], [], 0
            for row in pending:
                text = chunk_from_row(row).embedding_text
                tokens = self.chunker.counter.count(text) + 2
                if selected and total_tokens + tokens > self.settings.embedding.batch_tokens:
                    break
                selected.append(row)
                texts.append(text)
                total_tokens += tokens
            pending = selected
            vectors, metrics = self.embeddings.embed(texts)
            self.index.put_vectors([(row["id"], row["key"], self.embeddings.key(text), vector)
                for row, text, vector in zip(pending, texts, vectors)])
            status.embedded_chunks += len(pending)
            for name in ("cache_hits", "inferred_texts", "tokens"):
                setattr(status, name, getattr(status, name) + metrics[name])
            progress(asdict(status))
            batches += 1
            if max_embedding_batches is not None and batches >= max_embedding_batches:
                break
        status.seconds = round(time.perf_counter() - started, 4)
        pending = self.index.counts()["pending_chunks"]
        status.phase = "cancelled" if status.cancelled else "indexing" if pending else "ready"
        if not status.cancelled and not pending:
            self.index.set_metadata(last_sync=utc_now(), **({"last_verified": utc_now()} if verify and paths is None else {}))
        progress(asdict(status))
        return asdict(status)
