"""Run an actual, network-disabled CPU embedding smoke test and save measurements."""
from pathlib import Path
import json
import socket
import time

import numpy as np
import psutil

from codeconverge.assets import MODEL_FILE, MODEL_ID, MODEL_SHA256, verified
from codeconverge.config import AppPaths

model_file = AppPaths.default().home / "models" / MODEL_FILE
assert verified(model_file, MODEL_SHA256)

def deny_network(*args, **kwargs):
    raise AssertionError("Network access attempted during local inference")

socket.socket = deny_network
socket.create_connection = deny_network
import llama_cpp
from codeconverge.qwen import QwenBackend
from codeconverge.settings import EmbeddingSettings

started = time.perf_counter()
model = QwenBackend(model_file, EmbeddingSettings())
load_seconds = time.perf_counter() - started
texts = ["def update_dashboard_filters(filters):\n    dashboard.filters = filters\n    dashboard.refresh_metrics()",
         "def calculate_invoice_total(items):\n    return sum(item.quantity * item.unit_price for item in items)"]
started = time.perf_counter()
vectors, tokens = model.embed(texts)
batch_seconds = time.perf_counter() - started
vectors = np.asarray(vectors, dtype=np.float32)
single = model.embed([texts[0]])[0][0]
assert vectors.shape == (2, 1024) and np.isfinite(vectors).all()
assert np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5)
consistency = float(vectors[0] @ single)
assert consistency > .999
query = "Instruct: Given a code search query, retrieve relevant source code that implements the requested behavior.\nQuery: Find where dashboard filter selections refresh the metrics"
started = time.perf_counter()
query_vector = model.embed([query])[0][0]
query_seconds = time.perf_counter() - started
result = {"real_model": True, "model": MODEL_ID, "sha256": MODEL_SHA256,
    "backend": f"llama-cpp-python {llama_cpp.__version__}", "device": "CPU", "threads": 4,
    "pooling": "last", "dimensions": 1024, "shape": list(vectors.shape),
    "normalized": True, "network_disabled": True, "load_seconds": load_seconds,
    "batch_seconds": batch_seconds, "batch_tokens": tokens, "warm_query_seconds": query_seconds,
    "batch_single_cosine": consistency, "sample_similarities": (vectors @ query_vector).tolist(),
    "process_rss_mib": psutil.Process().memory_info().rss / (1024**2),
    "model_metadata": {k: v for k,v in model.metadata.items() if k in
        ["general.architecture", "general.file_type", "qwen3.pooling_type", "tokenizer.ggml.add_bos_token", "tokenizer.ggml.add_eos_token"]}}
output = Path(__file__).resolve().parent.parent / "artifacts" / "benchmarks" / "model-smoke.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2), flush=True)
model.close()
