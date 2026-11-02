"""User-level locations and non-secret runtime identity."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppPaths:
    home: Path

    @classmethod
    def default(cls) -> AppPaths:
        explicit = os.environ.get("CODECONVERGE_HOME")
        if explicit:
            return cls(Path(explicit).resolve())
        # A packaged Windows installer may write through AppData virtualization.
        # Use its canonical, user-owned installation pointer for CLI operations
        # as well as editor sessions, so models and indexes are shared once.
        pointer = Path.home() / ".codeconverge" / "installation.json"
        try:
            installation = json.loads(pointer.read_text(encoding="utf-8-sig"))
            registered = Path(installation["home"])
            if installation.get("product") == "CodeConverge" and registered.is_absolute():
                return cls(registered.resolve())
        except (OSError, ValueError, KeyError, TypeError):
            pass
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            raise RuntimeError("CodeConverge requires Windows LOCALAPPDATA")
        return cls((Path(base) / "CodeConverge").resolve())

    def initialize(self) -> None:
        for name in ("config", "models", "parsers", "indexes", "logs", "cache"):
            directory = self.home / name
            directory.mkdir(parents=True, exist_ok=True)
            if not directory.resolve().is_relative_to(self.home.resolve()):
                raise ValueError("An application storage directory is redirected outside its configured home")

    def host_identity(self) -> str:
        self.initialize()
        path = self.home / "config" / "host-id"
        try:
            with path.open("x", encoding="ascii") as file:
                file.write(secrets.token_hex(32))
        except FileExistsError:
            pass
        return path.read_text(encoding="ascii").strip()

    @property
    def pipe_name(self) -> str:
        # The directory is included so tests and portable installations cannot
        # accidentally connect to a different application's engine.
        suffix = hashlib.sha256(str(self.home).casefold().encode()).hexdigest()[:24]
        return rf"\\.\pipe\codeconverge-{suffix}"

    @property
    def mutex_name(self) -> str:
        return "Local\\" + self.pipe_name.rsplit("\\", 1)[-1]
