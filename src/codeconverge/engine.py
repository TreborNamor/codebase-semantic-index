"""Shared local engine: editor capabilities, session isolation and maintenance approval."""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from datetime import datetime, timezone

from . import __version__
from .config import AppPaths
from .errors import CodeConvergeError
from .manager import IndexManager
from .workspace import Scope, WorkspaceRegistry


class Engine:
    def __init__(self, paths: AppPaths, *, manager=None):
        self.paths = paths
        paths.initialize()
        self.registry = WorkspaceRegistry(paths.host_identity(), paths.home)
        self.manager = manager or IndexManager(paths)
        self.boot_id = secrets.token_hex(8)
        self._audit_lock = threading.Lock()
        self._lifecycle = threading.RLock()
        self._confirmations: dict[str, dict] = {}
        self._confirmation_lock = threading.Lock()
        self.last_session_at = time.monotonic()
        self.stop_requested = threading.Event()

    def dispatch(self, owner: str, request: dict) -> dict:
        operation = request.get("op")
        if operation == "ping":
            return {"product": "CodeConverge", "version": __version__, "boot_id": self.boot_id,
                "pid": os.getpid(), "editor_sessions": self.registry.session_count}
        if operation == "shutdown":
            with self._lifecycle:
                if self.registry.session_count:
                    raise CodeConvergeError("ENGINE_BUSY", "Close VS Code windows using CodeConverge before stopping its shared engine.")
                self.stop_requested.set()
                return {"stopping": True}
        if operation == "open_session":
            with self._lifecycle:
                session = self.registry.open(owner, request.get("roots", []), request.get("trusted") is True)
                scope = self.registry.scope(session["session_id"], session["mcp_token"])
                self.manager.attach(scope.session_id, scope.roots)
                self.last_session_at = time.monotonic()
                return session
        if operation == "update_session":
            with self._lifecycle:
                self.registry.control_scope(owner, request["session_id"], request["control_token"])
                try:
                    result = self.registry.update(request["session_id"], request["control_token"], request.get("roots", []), request.get("trusted") is True)
                finally:
                    scope = self.registry.control_scope(owner, request["session_id"], request["control_token"])
                    self.manager.attach(scope.session_id, scope.roots)
                return result
        if operation in {"editor_status", "file_events", "confirm_maintenance"}:
            scope = self.registry.control_scope(owner, request["session_id"], request["control_token"])
            if operation == "file_events":
                self.manager.notify(scope, request["project_id"], request.get("paths"))
                return {"scheduled": True}
            if operation == "confirm_maintenance":
                with self._lifecycle:
                    self.registry.verify_current(scope)
                    return self.confirm(scope, request["request_id"], request.get("approved") is True)
            result = self.manager.status(scope)
            result["confirmations"] = self.pending_confirmations(scope)
            self.registry.verify_current(scope)
            return result
        if operation == "call_tool":
            scope = self.registry.scope(request["session_id"], request["token"])
            name = request["tool"]
            args = request.get("arguments", {})
            if not isinstance(args, dict):
                raise CodeConvergeError("INVALID_REQUEST", "Tool arguments must be an object.")
            if name == "index_status":
                result = {"product": "CodeConverge", "version": __version__, **self.manager.status(scope)}
                for project in result["projects"]:
                    project.pop("watch_owner", None)
            elif name in {"search_code", "find_symbol"}:
                result = self.manager.search(scope, args.get("query", args.get("name", "")),
                    mode="symbol" if name == "find_symbol" else args.get("mode", "auto"), top_k=args.get("top_k", 10),
                    paths=args.get("paths"), languages=args.get("languages"))
            elif name == "refresh_index":
                result = self.prepare(scope, "rebuild", [r.project_id for r in scope.roots]) if args.get("full_rebuild", False) else self.manager.refresh(scope)
            elif name == "manage_index":
                action = args.get("action", "list")
                if action in {"list", "status"}:
                    result = {"projects": self.manager.cached_projects(), "cache_limit_mb": self.manager.settings.index.cache_limit_mb,
                        "cleanup_policy": self.manager.settings.index.cleanup_policy}
                elif action == "delete":
                    pid = args.get("project_id")
                    cached = {p["project_id"]: p for p in self.manager.cached_projects()}
                    if pid not in cached:
                        raise CodeConvergeError("INVALID_PROJECT", "Select a project identifier from manage_index list.")
                    if cached[pid]["active"]:
                        raise CodeConvergeError("PROJECT_ACTIVE", "Close the project's editor windows before deleting its cache.")
                    result = self.prepare(scope, "delete", [pid])
                elif action == "cleanup":
                    result = self.prepare(scope, "delete", [p["project_id"] for p in self.manager.cached_projects() if not p["active"]])
                else:
                    raise CodeConvergeError("INVALID_ACTION", "Use list, status, delete or cleanup.")
            else:
                raise CodeConvergeError("UNKNOWN_TOOL", "Unknown CodeConverge tool.")
            self.registry.verify_current(scope)
            self.audit(name, scope.session_id, scope.generation, [r.project_id for r in scope.roots])
            return result
        raise CodeConvergeError("INVALID_OPERATION", "Unknown engine operation.")

    def prepare(self, scope: Scope, action: str, project_ids: list[str]):
        if action == "rebuild":
            scope.require_roots()
        if not project_ids:
            return {"scheduled": [], "message": "No cached projects qualify for this operation."}
        key = secrets.token_hex(16)
        with self._confirmation_lock:
            self._expire_confirmations()
            for item in self._confirmations.values():
                if item["session_id"] == scope.session_id and item["generation"] == scope.generation and item["action"] == action and item["project_ids"] == project_ids:
                    return {"confirmation_required": True, "request_id": item["request_id"], "message": "Approve the pending maintenance dialog in this VS Code window."}
            if sum(v["session_id"] == scope.session_id for v in self._confirmations.values()) >= 3:
                raise CodeConvergeError("CONFIRMATION_PENDING", "Resolve pending maintenance requests in VS Code first.")
            self._confirmations[key] = {"request_id": key, "session_id": scope.session_id, "generation": scope.generation,
                "action": action, "project_ids": project_ids, "expires": time.monotonic() + 120}
        return {"confirmation_required": True, "request_id": key, "message": "Approve the exact maintenance operation in the originating VS Code window; this request has not changed stored indexes."}

    def _expire_confirmations(self):
        for key in [key for key, item in self._confirmations.items() if item["expires"] <= time.monotonic()]:
            del self._confirmations[key]

    def pending_confirmations(self, scope: Scope):
        with self._confirmation_lock:
            self._expire_confirmations()
            return [{k: item[k] for k in ("request_id", "action", "project_ids")} for item in self._confirmations.values()
                if item["session_id"] == scope.session_id and item["generation"] == scope.generation]

    def confirm(self, scope: Scope, request_id: str, approved: bool):
        with self._confirmation_lock:
            self._expire_confirmations()
            item = self._confirmations.get(request_id)
            if item is None or (item["session_id"], item["generation"]) != (scope.session_id, scope.generation):
                raise CodeConvergeError("INVALID_CONFIRMATION", "This maintenance request expired or belongs to a different workspace session.")
            del self._confirmations[request_id]
        if not approved:
            return {"cancelled": True}
        self.registry.verify_current(scope)
        result = self.manager.rebuild(scope) if item["action"] == "rebuild" else self.manager.delete_cached(item["project_ids"])
        self.audit("confirmed_" + item["action"], scope.session_id, scope.generation, item["project_ids"])
        return result

    def audit(self, tool: str, session_id: str, generation: int, projects: list[str]) -> None:
        entry = {"at": datetime.now(timezone.utc).isoformat(), "boot_id": self.boot_id, "tool": tool, "session_id": session_id, "generation": generation, "project_ids": projects}
        path = self.paths.home / "logs" / "tool-calls.jsonl"
        with self._audit_lock:
            if path.exists() and path.stat().st_size > 2_000_000:
                path.replace(path.with_suffix(".previous.jsonl"))
            with path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(entry) + "\n")

    def close_owner(self, owner: str) -> None:
        with self._lifecycle:
            had_sessions = self.registry.session_count > 0
            self.registry.close_owner(owner)
            self.manager.retain_sessions(self.registry.session_ids)
            if had_sessions and self.registry.session_count == 0:
                self.last_session_at = time.monotonic()

    @property
    def idle(self):
        return self.stop_requested.is_set() or self.registry.session_count == 0 and time.monotonic() - self.last_session_at > self.manager.settings.index.engine_idle_seconds

    def close(self):
        self.manager.close()
