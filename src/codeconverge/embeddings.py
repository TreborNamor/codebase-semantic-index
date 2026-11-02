"""One lazily loaded CPU model, query priority and persistent vector memoization."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
from pathlib import Path
import sqlite3
import threading
import time

import numpy as np

from .assets import MODEL_FILE
from .config import AppPaths
from .database import connection, is_corruption, quarantine
from .qwen import QwenBackend
from .settings import EmbeddingSettings


class EmbeddingCache:
    def __init__(self, path: Path, dimensions: int, max_mb: int):
        self.path, self.dimensions, self.max_bytes = path, dimensions, max_mb * 1024**2
        self._lock = threading.RLock()
        self.warnings = []
        try:
            self._initialize()
        except sqlite3.DatabaseError as error:
            if not is_corruption(error):
                raise
            saved = quarantine(path)
            self.warnings.append(f"Corrupt embedding cache preserved in {saved.name}; cache will refill locally.")
            self._initialize()

    def _initialize(self):
        with connection(self.path) as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise sqlite3.DatabaseError("Embedding cache integrity check failed")
            db.execute("CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, used REAL NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS vectors_used ON vectors(used)")

    def get(self, keys: list[str]) -> dict[str, np.ndarray]:
        return self._recovering(self._get, keys)

    def _recovering(self, operation, value):
        try:
            return operation(value)
        except sqlite3.DatabaseError as error:
            if not is_corruption(error):
                raise
            with self._lock:
                saved = quarantine(self.path)
                self.warnings.append(f"Embedding cache recovered; damaged files preserved in {saved.name}.")
                self._initialize()
            return operation(value)

    def _get(self, keys: list[str]) -> dict[str, np.ndarray]:
        found = {}
        if not keys:
            return found
        with self._lock, connection(self.path) as db:
            for offset in range(0, len(keys), 500):
                group = keys[offset:offset + 500]
                marks = ",".join("?" for _ in group)
                for row in db.execute(f"SELECT key, vector FROM vectors WHERE dimensions=? AND key IN ({marks})", [self.dimensions, *group]):
                    vector = np.frombuffer(row["vector"], dtype="<f4").copy()
                    if vector.shape == (self.dimensions,) and np.isfinite(vector).all() and abs(float(np.linalg.norm(vector)) - 1) < .001:
                        found[row["key"]] = vector
                if found:
                    db.executemany("UPDATE vectors SET used=? WHERE key=?", [(time.time(), key) for key in group if key in found])
        return found

    def put(self, values: dict[str, np.ndarray]):
        return self._recovering(self._put, values)

    def _put(self, values: dict[str, np.ndarray]):
        if not values:
            return
        with self._lock, connection(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.executemany("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)",
                    [(key, self.dimensions, np.asarray(vector, dtype="<f4").tobytes(), time.time()) for key, vector in values.items()])
                total = db.execute("SELECT COALESCE(SUM(length(vector)),0) FROM vectors").fetchone()[0]
                if total > self.max_bytes:
                    remove = (total - self.max_bytes) // (self.dimensions * 4) + 1
                    db.execute("DELETE FROM vectors WHERE key IN (SELECT key FROM vectors ORDER BY used LIMIT ?)", (remove,))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise


class EmbeddingProvider:
    def __init__(self, paths: AppPaths, settings: EmbeddingSettings, *, model_path: Path | None = None):
        self.paths, self.settings = paths, settings
        self.model_path = model_path or paths.home / "models" / MODEL_FILE
        self.cache = EmbeddingCache(paths.home / "cache" / "embeddings.sqlite", settings.dimensions, settings.cache_mb)
        self._condition = threading.Condition()
        self._busy = False
        self._waiting_queries = 0
        self._backend: QwenBackend | None = None
        self.hits = 0
        self.misses = 0
        self.inferred_texts = 0
        self.inferred_tokens = 0
        self.last_used = time.monotonic()
        self.last_error: str | None = None

    def key(self, text: str, *, query: bool = False) -> str:
        return hashlib.sha256(f"{self.settings.identity}\0{'query' if query else 'document'}\0{text}".encode()).hexdigest()

    @contextmanager
    def _turn(self, query: bool):
        with self._condition:
            if query:
                self._waiting_queries += 1
            try:
                self._condition.wait_for(lambda: not self._busy and (query or self._waiting_queries == 0))
                self._busy = True
            finally:
                if query:
                    self._waiting_queries -= 1
        try:
            yield
        finally:
            with self._condition:
                self._busy = False
                self._condition.notify_all()

    def embed(self, texts: list[str], *, query: bool = False) -> tuple[list[np.ndarray], dict]:
        keys = [self.key(text, query=query) for text in texts]
        found = self.cache.get(keys)
        missing = dict((key, text) for key, text in zip(keys, texts) if key not in found)
        hits = len(keys) - sum(key not in found for key in keys)
        inferred = tokens = 0
        if missing:
            with self._turn(query):
                # Another request may have populated an identical content key.
                found.update(self.cache.get(list(missing)))
                missing = {key: text for key, text in missing.items() if key not in found}
                if missing:
                    try:
                        if self._backend is None:
                            self._backend = QwenBackend(self.model_path, self.settings)
                        vectors, tokens = self._backend.embed(list(missing.values()))
                        import psutil
                        if psutil.Process().memory_info().rss > self.settings.memory_budget_mb * 1024**2:
                            raise RuntimeError("Configured process memory budget was exceeded; reduce embedding batch sizes")
                        additions = dict(zip(missing, vectors))
                        self.cache.put(additions)
                        found.update(additions)
                        inferred = len(missing)
                        self.inferred_texts += inferred
                        self.inferred_tokens += tokens
                        self.last_error = None
                    except Exception as error:
                        self.last_error = f"{type(error).__name__}: {error}"
                        if self._backend:
                            self._backend.close()
                            self._backend = None
                        raise
        self.hits += hits
        self.misses += inferred
        self.last_used = time.monotonic()
        return [found[key] for key in keys], {"cache_hits": hits, "inferred_texts": inferred, "tokens": tokens}

    def query(self, query: str, counter) -> tuple[np.ndarray, bool]:
        prefix = f"Instruct: {self.settings.query_instruction}\nQuery: "
        available = self.settings.batch_tokens - counter.count(prefix) - 8
        if available < 16:
            raise ValueError("The query instruction exceeds the configured embedding token budget")
        clipped = counter.prefix(query, min(self.settings.query_tokens, available))
        text = prefix + clipped
        vector, _ = self.embed([text], query=True)
        return vector[0], clipped != query

    def unload_if_idle(self, *, force=False) -> bool:
        with self._condition:
            if self._busy or self._waiting_queries:
                return False
            if self._backend and (force or time.monotonic() - self.last_used >= self.settings.idle_seconds):
                self._backend.close()
                self._backend = None
                return True
        return False

    @property
    def loaded(self) -> bool:
        return self._backend is not None

    def status(self) -> dict:
        return {"identity": "Qwen/Qwen3-Embedding-0.6B-GGUF", "quantization": "Q8_0", "device": "CPU",
            "dimensions": self.settings.dimensions, "threads": self.settings.threads, "loaded": self.loaded,
            "cache_hits": self.hits, "inferred_texts": self.inferred_texts, "inferred_tokens": self.inferred_tokens,
            "error": self.last_error}
