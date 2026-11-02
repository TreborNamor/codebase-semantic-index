"""Reference-counted projects and a single fair, resumable background indexing worker."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import threading
import time

from .chunking import Chunker
from .config import AppPaths
from .database import is_corruption
from .embeddings import EmbeddingProvider
from .errors import CodeConvergeError
from .parsers import ParserLibrary
from .retrieval import Retriever, validate
from .settings import Settings
from .storage import ProjectIndex
from .synchronization import Synchronizer
from .tokenization import TokenCounter
from .workspace import Scope, WorkspaceRoot


@dataclass
class ProjectState:
    root: WorkspaceRoot
    index: ProjectIndex
    sessions: set[str] = field(default_factory=set)
    watch_owner: str | None = None
    queued: bool = False
    dirty: set[str] | None = None
    verify: bool = True
    due: float = 0
    last_started: float = 0
    last_reconcile: float = 0
    last_verify: float = 0
    running: bool = False
    epoch: int = 0
    progress: dict = field(default_factory=dict)
    error: str | None = None
    totals: dict = field(default_factory=lambda: {"changed_files": 0, "unchanged_files": 0, "inferred_texts": 0, "cache_hits": 0})


class IndexManager:
    def __init__(self, paths: AppPaths, settings: Settings | None = None, *, embeddings=None, assets_home: Path | None = None, start=True):
        self.paths = paths
        paths.initialize()
        self.settings = settings or Settings.load(paths.home)
        self.settings.validate()
        assets = assets_home or paths.home
        self.counter = TokenCounter(assets)
        self.chunker = Chunker(ParserLibrary(assets / "parsers"), self.counter, self.settings.index.chunk_tokens)
        from .assets import MODEL_FILE
        self.embeddings = embeddings or EmbeddingProvider(paths, self.settings.embedding, model_path=assets / "models" / MODEL_FILE)
        self.retriever = Retriever(self.embeddings, self.counter, self.settings)
        self.projects: dict[str, ProjectState] = {}
        self._condition = threading.Condition(threading.RLock())
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._work, name="codeconverge-indexer", daemon=True)
        self._last_cleanup = 0
        self._storage_warnings: set[str] = set()
        if start:
            self._thread.start()

    def attach(self, session_id: str, roots: tuple[WorkspaceRoot, ...]):
        wanted = {root.project_id for root in roots}
        with self._condition:
            for pid, state in self.projects.items():
                if session_id in state.sessions and pid not in wanted:
                    state.sessions.discard(session_id)
                    if state.watch_owner not in state.sessions:
                        state.watch_owner = min(state.sessions) if state.sessions else None
                    if not state.sessions:
                        state.epoch += 1
                        state.queued = False
                        state.index.touch()
            for root in roots:
                state = self.projects.get(root.project_id)
                if state is None:
                    state = self.projects[root.project_id] = ProjectState(root, ProjectIndex(self.paths, root,
                        self.settings.embedding.dimensions, self.settings.embedding.identity))
                fresh = not state.sessions
                state.sessions.add(session_id)
                if state.watch_owner is None:
                    state.watch_owner = session_id
                if fresh:
                    state.index.touch()
                    self._queue(state, None, verify=True)
            self._condition.notify_all()

    def retain_sessions(self, session_ids: set[str]):
        with self._condition:
            for state in self.projects.values():
                had_sessions = bool(state.sessions)
                state.sessions.intersection_update(session_ids)
                if state.watch_owner not in state.sessions:
                    state.watch_owner = min(state.sessions) if state.sessions else None
                if had_sessions and not state.sessions:
                    state.epoch += 1
                    state.queued = False
                    state.index.touch()
            self._condition.notify_all()

    def _queue(self, state: ProjectState, paths: set[str] | None, *, verify=False, debounce=False):
        if not state.sessions:
            return
        if not state.queued:
            state.dirty = paths
            state.verify = verify
        elif state.dirty is not None:
            state.dirty = None if paths is None else state.dirty | paths
        state.verify |= verify
        state.queued = True
        state.due = time.monotonic() + (self.settings.index.debounce_ms / 1000 if debounce else 0)
        self._condition.notify_all()

    def notify(self, scope: Scope, project_id: str, paths: list[str] | None):
        scope.require_roots()
        if project_id not in {root.project_id for root in scope.roots}:
            raise CodeConvergeError("UNAUTHORIZED_PROJECT", "The project is outside this editor session.")
        if paths is not None:
            if not isinstance(paths, list) or len(paths) > 2048:
                raise CodeConvergeError("INVALID_CHANGE", "Supply at most 2048 workspace-relative changed paths.")
            # Reuse retrieval path validation, then reject glob syntax in events.
            for relative in paths:
                validate("change", 1, "lexical", [relative], [])
                if any(char in relative for char in "*?["):
                    raise CodeConvergeError("INVALID_CHANGE", "Filesystem events must use literal relative paths.")
        with self._condition:
            state = self.projects.get(project_id)
            if state and scope.session_id in state.sessions:
                self._queue(state, None if paths is None else set(p.replace("\\", "/") for p in paths), verify=True, debounce=True)

    def _stale(self, project_id: str, path: str):
        with self._condition:
            state = self.projects.get(project_id)
            if state:
                self._queue(state, {path}, verify=True, debounce=True)

    def search(self, scope: Scope, query, **kwargs):
        with self._condition:
            indexes = {root.project_id: self.projects[root.project_id].index for root in scope.roots if root.project_id in self.projects}
        try:
            result = self.retriever.search(scope, indexes, query, stale=self._stale, **kwargs)
        except sqlite3.DatabaseError as error:
            if not is_corruption(error):
                raise
            with self._condition:
                for root in scope.roots:
                    self._recover(self.projects[root.project_id])
            raise CodeConvergeError("INDEX_RECOVERING", "A damaged index is being rebuilt locally. Retry after index_status reports readiness.") from error
        statuses = self.status(scope)["projects"]
        result["freshness"] = [{"project_id": s["project_id"], "state": s["state"], "last_sync": s["last_sync"]} for s in statuses]
        result["partial"] |= any(s["state"] != "ready" for s in statuses)
        while result["results"] and len(json.dumps(result, ensure_ascii=False)) > self.settings.index.output_characters:
            result["results"].pop()
        return result

    def status(self, scope: Scope) -> dict:
        with self._condition:
            states = [(root, self.projects.get(root.project_id)) for root in scope.roots]
            values = []
            for root, state in states:
                if state is None:
                    values.append({**root.as_dict(), "state": "queued", "indexed_files": 0, "chunks": 0, "embedded_chunks": 0, "pending_chunks": 0, "last_sync": None})
                    continue
                try:
                    counts, metadata = state.index.counts(), state.index.metadata()
                except sqlite3.DatabaseError as error:
                    if not is_corruption(error):
                        raise
                    self._recover(state)
                    counts, metadata = state.index.counts(), state.index.metadata()
                status = "error" if state.error else "indexing" if state.running or state.queued or counts["pending_chunks"] else "ready"
                values.append({**root.as_dict(), **counts, "state": status, "progress": dict(state.progress),
                    "last_sync": metadata.get("last_sync"), "watch_owner": state.watch_owner,
                    "warnings": [*state.index.warnings, *([state.error] if state.error else [])], "totals": dict(state.totals)})
        readiness = "untrusted_workspace" if not scope.trusted else "no_active_workspace" if not scope.roots else "error" if any(v["state"] == "error" for v in values) else "indexing" if any(v["state"] != "ready" for v in values) else "ready"
        return {"session_id": scope.session_id, "generation": scope.generation, "trusted": scope.trusted,
            "roots": [r.as_dict() for r in scope.roots], "readiness": readiness, "projects": values,
            "indexed_files": sum(v["indexed_files"] for v in values), "chunks": sum(v["chunks"] for v in values),
            "model": self.embeddings.status(), "warnings": sorted(self.chunker.parsers.warnings | self.counter.warnings | self._storage_warnings)}

    def _recover(self, state):
        state.epoch += 1
        with state.index.lock:
            state.index = ProjectIndex(self.paths, state.root, self.settings.embedding.dimensions, self.settings.embedding.identity)
        state.error = None
        self._queue(state, None, verify=True)

    def refresh(self, scope: Scope):
        scope.require_roots()
        with self._condition:
            for root in scope.roots:
                self._queue(self.projects[root.project_id], None, verify=True)
        return {"scheduled": [root.project_id for root in scope.roots], "operation": "incremental_sync"}

    def rebuild(self, scope: Scope):
        """Called only after a control-channel user confirmation, never MCP args."""
        scope.require_roots()
        # Wait for the old slice to cancel before clearing its committed rows.
        with self._condition:
            states = [self.projects[root.project_id] for root in scope.roots]
            for state in states:
                state.epoch += 1
            self._condition.wait_for(lambda: all(not s.running for s in states), timeout=30)
            if any(s.running for s in states):
                raise CodeConvergeError("INDEX_BUSY", "The current CPU batch is still finishing. Retry rebuilding shortly.")
            for state in states:
                state.index.clear()
                self._queue(state, None, verify=True)
        return {"scheduled": [s.root.project_id for s in states], "operation": "rebuild_reusing_embedding_cache"}

    def cached_projects(self) -> list[dict]:
        result = []
        for directory in (self.paths.home / "indexes").iterdir():
            if not re.fullmatch(r"[a-f0-9]{32}", directory.name) or directory.is_symlink() or directory.is_junction():
                continue
            try:
                data = json.loads((directory / "project.json").read_text(encoding="utf-8"))
                data["bytes"] = sum(p.stat().st_size for p in directory.rglob("*") if p.is_file() and not p.is_symlink())
                with self._condition:
                    state = self.projects.get(directory.name)
                    data["active"] = bool(state and (state.sessions or state.running))
                result.append(data)
            except (OSError, ValueError):
                continue
        return sorted(result, key=lambda v: v.get("last_used", ""), reverse=True)

    def delete_cached(self, project_ids: list[str]) -> dict:
        with self._condition:
            targets = []
            for pid in project_ids:
                if not isinstance(pid, str) or not re.fullmatch(r"[a-f0-9]{32}", pid):
                    raise CodeConvergeError("INVALID_PROJECT", "Invalid cached project identifier.")
                state = self.projects.get(pid)
                if state and (state.sessions or state.running):
                    raise CodeConvergeError("PROJECT_ACTIVE", "Close every VS Code window using this project before deleting its cache.")
                parent = (self.paths.home / "indexes").resolve()
                target = parent / pid
                if target.resolve().parent != parent or target.is_symlink() or target.is_junction():
                    raise CodeConvergeError("UNSAFE_STORAGE", "The index directory was redirected.")
                # shutil on Windows does not descend junctions. Reject every
                # reparse directory anyway before recursively removing a cache.
                if target.exists() and any(p.is_symlink() or p.is_junction() for p in target.rglob("*")):
                    raise CodeConvergeError("UNSAFE_STORAGE", "The cached index contains redirected paths.")
                targets.append((pid, target))
            for pid, target in targets:
                if target.exists():
                    shutil.rmtree(target)
                self.projects.pop(pid, None)
        return {"deleted": project_ids}

    def _work(self):
        while not self._stop.is_set():
            with self._condition:
                now = time.monotonic()
                for state in self.projects.values():
                    if state.sessions and not state.queued and not state.running and now - state.last_reconcile >= self.settings.index.reconcile_seconds:
                        self._queue(state, None, verify=now - state.last_verify >= self.settings.index.verify_seconds)
                ready = [s for s in self.projects.values() if s.sessions and s.queued and s.due <= now]
                if not ready:
                    self._condition.wait(timeout=.25)
                    self.embeddings.unload_if_idle()
                    continue
                state = min(ready, key=lambda s: (s.last_started, s.due, s.root.project_id))
                paths, verify, epoch = state.dirty, state.verify, state.epoch
                state.queued, state.running = False, True
                state.last_started = now
                if paths is None:
                    state.last_reconcile = now
                    if verify:
                        state.last_verify = now
            def cancelled():
                return self._stop.is_set() or state.epoch != epoch or not state.sessions
            def progress(value):
                with self._condition:
                    state.progress = value
            try:
                result = Synchronizer(state.index, self.chunker, self.embeddings, self.settings).run(
                    paths=paths, verify=verify, cancelled=cancelled, progress=progress, max_embedding_batches=1)
                with self._condition:
                    state.error = None
                    for key in state.totals:
                        state.totals[key] += result[key]
                    if result["phase"] == "indexing" and state.sessions:
                        self._queue(state, set())
            except Exception as error:
                logging.exception("Project synchronization failed project=%s", state.root.project_id)
                with self._condition:
                    state.error = f"{type(error).__name__}: {error}"
                    if isinstance(error, sqlite3.DatabaseError) and is_corruption(error):
                        try:
                            self._recover(state)
                        except Exception:
                            logging.exception("Index recovery failed")
            finally:
                with self._condition:
                    state.running = False
                    self._condition.notify_all()
            if time.monotonic() - self._last_cleanup > 300:
                self._last_cleanup = time.monotonic()
                self._cleanup_policy()
        self.embeddings.unload_if_idle(force=True)

    def _cleanup_policy(self):
        projects = self.cached_projects()
        total = sum(p["bytes"] for p in projects)
        self._storage_warnings = {"Project cache exceeds index.cache_limit_mb; inspect Manage Cached Projects or opt into LRU cleanup."} if total > self.settings.index.cache_limit_mb * 1024**2 else set()
        if self.settings.index.cleanup_policy != "lru":
            return
        cutoff = time.time() - self.settings.index.cleanup_days * 86400
        for project in reversed(projects):
            try:
                old = datetime.fromisoformat(project["last_used"]).timestamp() < cutoff
                if not project["active"] and (old or total > self.settings.index.cache_limit_mb * 1024**2):
                    self.delete_cached([project["project_id"]])
                    total -= project["bytes"]
            except (ValueError, KeyError, OSError, CodeConvergeError):
                logging.exception("Configured cache cleanup skipped a project")

    def close(self):
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        if self._thread.is_alive():
            self._thread.join(timeout=30)
        self.embeddings.unload_if_idle(force=True)
