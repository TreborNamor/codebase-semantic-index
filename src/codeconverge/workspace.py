"""Workspace authority granted by editor control sessions, never by MCP input."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
from dataclasses import dataclass
from pathlib import Path

from .errors import CodeConvergeError


@dataclass(frozen=True)
class WorkspaceRoot:
    project_id: str
    path: Path
    name: str

    def as_dict(self) -> dict:
        return {"project_id": self.project_id, "path": str(self.path), "name": self.name}


@dataclass
class WorkspaceSession:
    session_id: str
    owner: str
    control_token: str
    mcp_token: str
    generation: int
    trusted: bool
    roots: tuple[WorkspaceRoot, ...]


@dataclass(frozen=True)
class Scope:
    session_id: str
    generation: int
    trusted: bool
    roots: tuple[WorkspaceRoot, ...]

    def require_roots(self) -> None:
        if not self.trusted:
            raise CodeConvergeError("UNTRUSTED_WORKSPACE", "Trust the opened workspace in VS Code before searching.")
        if not self.roots:
            raise CodeConvergeError("NO_ACTIVE_WORKSPACE", "No workspace folder is open in this VS Code window.")


def canonical_root(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise CodeConvergeError("INVALID_ROOT", "Workspace roots must be absolute directories supplied by VS Code.")
    try:
        path = path.resolve(strict=True)
    except (OSError, ValueError) as exc:
        raise CodeConvergeError("INVALID_ROOT", "The workspace folder is unavailable.") from exc
    if not path.is_dir():
        raise CodeConvergeError("INVALID_ROOT", "The workspace root is not a directory.")
    if os.name == "nt":
        import win32file
        if str(path).startswith("\\\\") or win32file.GetDriveType(path.anchor) == 4:
            raise CodeConvergeError("REMOTE_WORKSPACE", "This release authorizes local Windows volumes only.")
    return path


def project_identity(host_id: str, path: Path) -> str:
    # Resolve aliases first; include Windows directory identity to distinguish
    # case-sensitive same-name directories. Ordinary path reuse remains stable
    # while the original directory exists.
    stat = path.stat()
    key = f"{host_id}\0{os.path.normcase(str(path))}\0{stat.st_dev}:{stat.st_ino}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def authorized_file(root: WorkspaceRoot, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or path.anchor or path.drive or ".." in path.parts or ":" in relative or "\x00" in relative:
        raise CodeConvergeError("UNAUTHORIZED_PATH", "Only workspace-relative paths are accepted.")
    try:
        candidate = (root.path / path).resolve(strict=True)
        candidate.relative_to(root.path)
    except (OSError, ValueError) as exc:
        raise CodeConvergeError("UNAUTHORIZED_PATH", "The file is unavailable or outside its authorized workspace.") from exc
    if not candidate.is_file():
        raise CodeConvergeError("UNAUTHORIZED_PATH", "The requested path is not a source file.")
    return candidate


class WorkspaceRegistry:
    def __init__(self, host_id: str, excluded_storage: Path):
        self.host_id = host_id
        self.excluded_storage = excluded_storage.resolve()
        self._sessions: dict[str, WorkspaceSession] = {}
        self._lock = threading.RLock()

    def _roots(self, values: list[dict], trusted: bool) -> tuple[WorkspaceRoot, ...]:
        if not trusted:
            return ()
        if not isinstance(values, list) or len(values) > 64 or any(not isinstance(item, dict) or not isinstance(item.get("path"), str) for item in values):
            raise CodeConvergeError("INVALID_ROOT", "Supply at most 64 workspace folders from VS Code.")
        roots = {}
        for item in values:
            path = canonical_root(item["path"])
            if path == self.excluded_storage or path.is_relative_to(self.excluded_storage):
                raise CodeConvergeError("INSTALLATION_ROOT", "Application storage cannot be indexed as source.")
            identity = project_identity(self.host_id, path)
            roots[identity] = WorkspaceRoot(identity, path, item.get("name") or path.name)
        return tuple(roots.values())

    def open(self, owner: str, values: list[dict], trusted: bool) -> dict:
        roots = self._roots(values, trusted)
        with self._lock:
            session = WorkspaceSession(secrets.token_hex(16), owner, secrets.token_hex(32), secrets.token_hex(32), 1, trusted, roots)
            self._sessions[session.session_id] = session
            return {"session_id": session.session_id, "control_token": session.control_token, "mcp_token": session.mcp_token, "generation": 1, "roots": [r.as_dict() for r in roots]}

    def update(self, session_id: str, token: str, values: list[dict], trusted: bool) -> dict:
        # Revoke the old generation before resolving new roots. Even a failed
        # replacement must not retain access to removed or newly untrusted roots.
        with self._lock:
            session = self._authenticate(session_id, token, control=True)
            session.generation += 1
            session.roots = ()
            session.trusted = False
            session.roots = self._roots(values, trusted)
            session.trusted = trusted
            return {"generation": session.generation, "roots": [r.as_dict() for r in session.roots]}

    def _authenticate(self, session_id: str, token: str, control: bool = False) -> WorkspaceSession:
        session = self._sessions.get(session_id)
        if session is None or not hmac.compare_digest(session.control_token if control else session.mcp_token, token):
            raise CodeConvergeError("INVALID_SESSION", "The editor session has closed or its capability is invalid.")
        return session

    def scope(self, session_id: str, token: str) -> Scope:
        with self._lock:
            session = self._authenticate(session_id, token)
            return Scope(session.session_id, session.generation, session.trusted, session.roots)

    def verify_current(self, scope: Scope) -> None:
        with self._lock:
            session = self._sessions.get(scope.session_id)
            if session is None or session.generation != scope.generation:
                raise CodeConvergeError("WORKSPACE_CHANGED", "The workspace changed during this request. Search again in the current session.")

    def close_owner(self, owner: str) -> None:
        with self._lock:
            for key in [key for key, session in self._sessions.items() if session.owner == owner]:
                del self._sessions[key]

    def control_scope(self, owner: str, session_id: str, token: str) -> Scope:
        with self._lock:
            session = self._authenticate(session_id, token, control=True)
            if session.owner != owner:
                raise CodeConvergeError("INVALID_SESSION", "Editor controls belong to their originating connection.")
            return Scope(session.session_id, session.generation, session.trusted, session.roots)

    @property
    def session_ids(self) -> set[str]:
        with self._lock:
            return set(self._sessions)

    @property
    def session_count(self) -> int:
        with self._lock:
            return len(self._sessions)
