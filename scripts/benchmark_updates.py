"""Measure saved-file notifications through the real background worker, up to 1k tokens."""
from pathlib import Path
import json
import socket
import tempfile
import time

import numpy as np

from codeconverge.config import AppPaths
from codeconverge.engine import Engine
from codeconverge.manager import IndexManager


def main():
    assets = AppPaths.default().home
    def deny(*args, **kwargs):
        raise AssertionError("Network access attempted")
    socket.socket = socket.create_connection = deny
    with tempfile.TemporaryDirectory(prefix="CodeConvergeUpdates-") as temporary:
        parent = Path(temporary).resolve()
        assert parent.parent == Path(tempfile.gettempdir()).resolve()
        root = parent / "workspace"
        root.mkdir()
        manager = IndexManager(AppPaths(parent / "app"), assets_home=assets)
        engine = Engine(manager.paths, manager=manager)
        session = engine.dispatch("editor", {"op":"open_session", "roots":[{"path":str(root)}], "trusted":True})
        def status():
            return engine.dispatch("editor", {"op":"call_tool", "session_id":session["session_id"], "token":session["mcp_token"], "tool":"index_status"})
        def ready():
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                value = status()
                if value["readiness"] == "ready":
                    return value
                if value["readiness"] == "error":
                    raise AssertionError(value)
                time.sleep(.025)
            raise AssertionError("Indexing timeout")
        try:
            ready()
            # Warm the one shared CPU model before measuring normal saved edits.
            manager.embeddings.embed(["def warmup(value): return value"])
            rows = []
            for size in (100, 500, 1000):
                for iteration in range(5):
                    version = size * 10 + iteration  # unique at every size; no reused prefixes
                    lines = []
                    while True:
                        proposed = [*lines, f"    value = (value * {len(lines) + 2} + {version}) % 1000003\n"]
                        text = f"def transform_events_{version}(value):\n" + "".join(proposed) + "    return value\n"
                        if manager.counter.count(text) > size:
                            break
                        lines = proposed
                    text = f"def transform_events_{version}(value):\n" + "".join(lines) + "    return value\n"
                    path = root / "events.py"
                    started = time.perf_counter()
                    hits, inferred = manager.embeddings.hits, manager.embeddings.inferred_texts
                    path.write_text(text, encoding="utf-8")
                    engine.dispatch("editor", {"op":"file_events", "session_id":session["session_id"], "control_token":session["control_token"],
                        "project_id":session["roots"][0]["project_id"], "paths":["events.py"]})
                    completed = ready()
                    row = {"budget_tokens":size, "actual_tokens":manager.counter.count(text),
                        "elapsed_ms":(time.perf_counter()-started)*1000, "counts":{key:completed["projects"][0][key] for key in ["chunks", "embedded_chunks"]}}
                    row.update(cache_hits=manager.embeddings.hits-hits, inferred_texts=manager.embeddings.inferred_texts-inferred)
                    rows.append(row)
                    print(json.dumps(row), flush=True)
            result = {"real_cpu_model":True, "offline_network_blocked":True, "samples":rows,
                "method": "Written file through editor-control notification, Python debounce 500 ms, background scheduling and committed embeddings. Extension's own 500 ms notification debounce is not included.",
                "p95_ms_by_budget": {str(size):float(np.percentile([r["elapsed_ms"] for r in rows if r["budget_tokens"] == size],95)) for size in (100,500,1000)}}
            output = Path(__file__).resolve().parent.parent / "artifacts/benchmarks/updates.json"
            output.write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
        finally:
            engine.close()


if __name__ == "__main__":
    main()
