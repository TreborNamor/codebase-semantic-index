"""Reproducible labeled retrieval and lifecycle measurements with the real CPU model.

No labels are indexed. No network is available. Fixture updates happen only in
a temporary copy, never in the benchmark sources or a user's open project.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import platform
import shutil
import socket
import statistics
import tempfile
import threading
import time

import numpy as np
import psutil

from codeconverge.assets import MODEL_FILE, MODEL_SHA256
from codeconverge.chunking import Chunker
from codeconverge.config import AppPaths
from codeconverge.embeddings import EmbeddingProvider
from codeconverge.parsers import ParserLibrary
from codeconverge.retrieval import Retriever
from codeconverge.scanning import FilePolicy, read_source
from codeconverge.settings import Settings
from codeconverge.storage import ProjectIndex
from codeconverge.synchronization import Synchronizer
from codeconverge.tokenization import TokenCounter
from codeconverge.workspace import Scope, WorkspaceRoot, project_identity


def percentile(values, percent):
    return float(np.percentile(values, percent)) if values else None


def metrics(rows):
    ranks = [row["relevant_rank"] for row in rows]
    return {"queries": len(rows), "recall_at_5": sum(r is not None and r <= 5 for r in ranks) / len(ranks),
        "recall_at_10": sum(r is not None and r <= 10 for r in ranks) / len(ranks),
        "mrr_at_10": sum(1 / r if r else 0 for r in ranks) / len(ranks),
        "latency_p50_ms": percentile([r["elapsed_ms"] for r in rows], 50),
        "latency_p95_ms": percentile([r["elapsed_ms"] for r in rows], 95)}


def main():
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--output", type=Path, default=Path("artifacts/benchmarks/retrieval.json"))
    args = arguments.parse_args()
    repository = Path(__file__).resolve().parent.parent
    corpus = repository / "benchmarks" / "corpus"
    labels_path = repository / "benchmarks" / "queries.json"
    labels = json.loads(labels_path.read_text(encoding="utf-8"))
    queries = labels["queries"]
    assert len(queries) >= 45 and len({q["id"] for q in queries}) == len(queries)
    digest = hashlib.sha256(labels_path.read_bytes())
    for path in sorted(corpus.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(corpus).as_posix().encode())
            digest.update(path.read_bytes())
    frozen_digest = digest.hexdigest()
    print(json.dumps({"event": "labels_frozen_before_inference", "sha256": frozen_digest, "queries": len(queries)}), flush=True)
    assets, settings = AppPaths.default(), Settings()
    process = psutil.Process()
    peak = process.memory_info().rss
    stop = threading.Event()
    def sample_memory():
        nonlocal peak
        while not stop.wait(.02):
            peak = max(peak, process.memory_info().rss)
    sampler = threading.Thread(target=sample_memory, daemon=True)
    sampler.start()
    original_socket, original_connect = socket.socket, socket.create_connection
    def deny_network(*_args, **_kwargs):
        raise AssertionError("Network attempted during the offline benchmark")
    socket.socket = socket.create_connection = deny_network
    provider = None
    try:
        with tempfile.TemporaryDirectory(prefix="CodeConvergeBenchmark-") as directory:
            temporary = Path(directory).resolve()
            assert temporary.parent == Path(tempfile.gettempdir()).resolve()
            workspace = temporary / "workspace"
            shutil.copytree(corpus, workspace)
            paths = AppPaths(temporary / "app")
            paths.initialize()
            root = WorkspaceRoot(project_identity(paths.host_identity(), workspace), workspace, "benchmark")
            counter = TokenCounter(assets.home)
            assert counter.exact, "Install the official Qwen tokenizer before benchmarking"
            chunker = Chunker(ParserLibrary(assets.home / "parsers"), counter, settings.index.chunk_tokens)
            assert chunker.parsers.records, "Install parser assets before benchmarking"
            index = ProjectIndex(paths, root, settings.embedding.dimensions, settings.embedding.identity)
            # Validate every labeled symbol against source structures before
            # performing inference or inspecting retrieval ranks.
            structures = {}
            source_bytes = source_tokens = 0
            for relative in FilePolicy(root, settings.files, (paths.home,)).discover():
                source = read_source(root, relative, settings.index.max_file_bytes)
                source_bytes += source.size
                source_tokens += counter.count(source.text)
                structures[relative] = chunker.chunk(root.project_id, source)
            invalid = [q for q in queries if q["path"] not in structures or q["symbol"] and not any(c.qualified_name == q["symbol"] for c in structures[q["path"]])]
            if invalid:
                raise AssertionError(f"Labels reference missing definitions: {[(q['id'], q['symbol']) for q in invalid]}; available: {[(p, [c.qualified_name for c in cs]) for p, cs in structures.items()]}")
            provider = EmbeddingProvider(paths, settings.embedding, model_path=assets.home / "models" / MODEL_FILE)
            sync = Synchronizer(index, chunker, provider, settings)
            last_report = 0
            def progress(status):
                nonlocal last_report
                if time.monotonic() - last_report > 4:
                    print(json.dumps({"event": "indexing", **status}), flush=True)
                    last_report = time.monotonic()
            initial = sync.run(progress=progress)
            assert index.counts()["pending_chunks"] == 0
            initial_counts = index.counts()
            scope = Scope("benchmark", 1, True, (root,))
            retriever = Retriever(provider, counter, settings)
            provider.unload_if_idle(force=True)
            cold_started = time.perf_counter()
            retriever.search(scope, {root.project_id: index}, queries[0]["query"], mode="semantic")
            cold_ms = (time.perf_counter() - cold_started) * 1000
            rows = []
            for number, query in enumerate(queries, 1):
                for mode in ("lexical", "semantic", "hybrid"):
                    before = provider.inferred_texts
                    result = retriever.search(scope, {root.project_id: index}, query["query"], mode=mode, top_k=10)
                    relevant = next((position for position, item in enumerate(result["results"], 1)
                        if item["path"] == query["path"] and (query["symbol"] is None or item["symbol"] == query["symbol"])), None)
                    rows.append({"id": query["id"], "split": query["split"], "mode": mode,
                        "relevant_rank": relevant, "elapsed_ms": result["elapsed_ms"],
                        "query_inference": provider.inferred_texts > before,
                        "top_results": [{"path": item["path"], "symbol": item["symbol"]} for item in result["results"]],
                        "warnings": result["warnings"]})
                if number % 8 == 0:
                    print(json.dumps({"event": "queries", "completed": number, "total": len(queries)}), flush=True)
            reused = sync.run()
            before = provider.inferred_texts
            reopened = ProjectIndex(paths, root, settings.embedding.dimensions, settings.embedding.identity)
            restart = Synchronizer(reopened, chunker, provider, settings).run()
            assert provider.inferred_texts == before and restart["changed_files"] == 0
            update_times = []
            update_tokens = []
            for number in range(10):
                path = workspace / "backend" / "incremental.py"
                text = f'def saved_change_{number}(value):\n    """Apply saved change number {number}."""\n    return value + {number}\n'
                path.write_text(text, encoding="utf-8")
                update_tokens.append(counter.count(text))
                started = time.perf_counter()
                Synchronizer(reopened, chunker, provider, settings).run(paths={"backend/incremental.py"})
                update_times.append((time.perf_counter() - started) * 1000)
            renamed = workspace / "backend" / "moved.py"
            path.rename(renamed)
            rename_stats = Synchronizer(reopened, chunker, provider, settings).run(paths={"backend/incremental.py", "backend/moved.py"})
            summaries = {split: {mode: metrics([r for r in rows if r["mode"] == mode and (split == "all" or r["split"] == split)])
                for mode in ("lexical", "semantic", "hybrid")} for split in ("all", "tuning", "heldout")}
            warm_inference = [r["elapsed_ms"] for r in rows if r["mode"] == "semantic" and r["query_inference"]]
            cache_bytes = sum(p.stat().st_size for p in (paths.home / "cache").rglob("*") if p.is_file())
            index_bytes = sum(p.stat().st_size for p in reopened.directory.rglob("*") if p.is_file())
            result = {"real_model": True, "offline_network_blocked": True, "dataset_sha256": frozen_digest,
                "methodology": labels["methodology"], "quality_limitations": "Small authored navigation fixture, one labeler, 48 queries and one run on one laptop; not evidence of large-repository generalization.",
                "hardware": {"cpu": platform.processor(), "logical_cpus": psutil.cpu_count(), "ram_gib": psutil.virtual_memory().total / 1024 ** 3},
                "settings": asdict(settings), "model_sha256": MODEL_SHA256, "source_files": len(structures), "source_bytes": source_bytes,
                "source_tokens": source_tokens, "initial_counts": initial_counts, "indexing": initial,
                "index_tokens_per_second": initial["tokens"] / initial["seconds"],
                "cold_query_ms": cold_ms, "warm_uncached_semantic_p95_ms": percentile(warm_inference, 95),
                "latency_method": "Model unloaded before cold query. Per query lexical, semantic, hybrid; hybrid reuses the query vector populated by semantic. warm_uncached_semantic excludes the one cold query and measures actual inference with a loaded model.",
                "summary": summaries, "queries": rows, "reopen_sync": reused, "persistent_index_reopen": restart,
                "rename_sync": rename_stats, "incremental_update_ms": update_times, "update_tokens": update_tokens,
                "update_p95_ms": percentile(update_times, 95), "peak_rss_mib": peak / 1024 ** 2,
                "index_bytes": index_bytes, "embedding_cache_bytes": cache_bytes}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({"output": str(args.output.resolve()), "summary": summaries, "indexing": initial, "cold_query_ms": cold_ms,
                "warm_uncached_semantic_p95_ms": result["warm_uncached_semantic_p95_ms"], "update_p95_ms": result["update_p95_ms"], "peak_rss_mib": result["peak_rss_mib"]}, indent=2), flush=True)
    finally:
        if provider:
            provider.unload_if_idle(force=True)
        socket.socket, socket.create_connection = original_socket, original_connect
        stop.set()
        sampler.join(timeout=2)


if __name__ == "__main__":
    main()
