"""Validated user settings and fingerprints for persistent index compatibility."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
import hashlib
import json
import math
import os
from pathlib import Path
import tomllib

from .assets import MODEL_SHA256


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class EmbeddingSettings:
    dimensions: int = 1024
    threads: int = min(4, os.cpu_count() or 1)
    batch_tokens: int = 512
    batch_sequences: int = 4
    query_tokens: int = 256
    memory_budget_mb: int = 2048
    idle_seconds: float = 300
    cache_mb: int = 512
    query_instruction: str = "Given a code search query, retrieve relevant source code that implements the requested behavior."

    @property
    def identity(self) -> str:
        # Thread/memory/idle settings do not change embedding identity.
        return fingerprint({"model_sha256": MODEL_SHA256, "pooling": "last", "normalized": True,
            "dimensions": self.dimensions, "query_instruction": self.query_instruction, "format": 1})


@dataclass(frozen=True)
class IndexSettings:
    chunk_tokens: int = 384
    max_file_bytes: int = 2 * 1024 * 1024
    debounce_ms: int = 500
    reconcile_seconds: float = 300
    verify_seconds: float = 1800
    engine_idle_seconds: float = 120
    cache_limit_mb: int = 10 * 1024
    cleanup_policy: str = "manual"
    cleanup_days: int = 90
    excerpt_lines: int = 24
    result_characters: int = 1600
    output_characters: int = 24000


@dataclass(frozen=True)
class FileSettings:
    excludes: tuple[str, ...] = ()
    respect_gitignore: bool = True


@dataclass(frozen=True)
class Settings:
    embedding: EmbeddingSettings = field(default_factory=EmbeddingSettings)
    index: IndexSettings = field(default_factory=IndexSettings)
    files: FileSettings = field(default_factory=FileSettings)
    projects: dict = field(default_factory=dict)

    @classmethod
    def load(cls, home: Path) -> Settings:
        path = home / "config" / "settings.toml"
        data = tomllib.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
        unknown = data.keys() - {"embedding", "index", "files", "projects"}
        if unknown:
            raise ValueError(f"Unknown settings sections: {', '.join(sorted(unknown))}")
        def section(name, kind):
            if not isinstance(data.get(name, {}), dict):
                raise ValueError(f"{name} must be a settings table")
            values = dict(data.get(name, {}))
            invalid = values.keys() - {item.name for item in fields(kind)}
            if invalid:
                raise ValueError(f"Unknown {name} settings: {', '.join(sorted(invalid))}")
            if "excludes" in values:
                if not isinstance(values["excludes"], list):
                    raise ValueError("files.excludes must be an array of glob strings")
                values["excludes"] = tuple(values["excludes"])
            return kind(**values)
        result = cls(section("embedding", EmbeddingSettings), section("index", IndexSettings),
            section("files", FileSettings), data.get("projects", {}))
        result.validate()
        return result

    def validate(self) -> None:
        e, i = self.embedding, self.index
        def integer(value, low, high, name):
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"{name} must be an integer from {low} to {high}")
        integer(e.dimensions, 32, 1024, "embedding.dimensions")
        integer(e.threads, 1, 64, "embedding.threads")
        integer(e.batch_tokens, 128, 2048, "embedding.batch_tokens")
        integer(e.batch_sequences, 1, 16, "embedding.batch_sequences")
        integer(e.query_tokens, 16, e.batch_tokens - 64, "embedding.query_tokens")
        integer(i.chunk_tokens, 48, e.batch_tokens - 64, "index.chunk_tokens")
        integer(i.max_file_bytes, 1024, 16 * 1024 * 1024, "index.max_file_bytes")
        integer(i.debounce_ms, 50, 5000, "index.debounce_ms")
        for name, value in [("idle_seconds", e.idle_seconds), ("reconcile_seconds", i.reconcile_seconds),
                            ("verify_seconds", i.verify_seconds), ("engine_idle_seconds", i.engine_idle_seconds)]:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 1:
                raise ValueError(f"{name} must be a positive duration")
        integer(e.memory_budget_mb, 768, 32768, "embedding.memory_budget_mb")
        integer(e.cache_mb, 1, 32768, "embedding.cache_mb")
        integer(i.cache_limit_mb, 768, 1024 * 1024, "index.cache_limit_mb")
        integer(i.cleanup_days, 1, 3650, "index.cleanup_days")
        if i.cleanup_policy not in {"manual", "lru"}:
            raise ValueError("index.cleanup_policy must be manual or lru")
        for name in ["excerpt_lines", "result_characters", "output_characters"]:
            integer(getattr(i, name), 1, 100000, f"index.{name}")
        if not isinstance(e.query_instruction, str) or not 1 <= len(e.query_instruction) <= 1024:
            raise ValueError("embedding.query_instruction must contain 1 to 1024 characters")
        if type(self.files.respect_gitignore) is not bool or not isinstance(self.files.excludes, (tuple, list)) or not all(isinstance(p, str) and 0 < len(p) <= 2048 for p in self.files.excludes):
            raise ValueError("Invalid file filtering settings")
        if not isinstance(self.projects, dict):
            raise ValueError("projects must be an optional table of file-filter overrides")
        for path, value in self.projects.items():
            if not isinstance(path, str) or not Path(path).is_absolute() or not isinstance(value, dict) or value.keys() - {"excludes", "respect_gitignore"}:
                raise ValueError("Project overrides support excludes and respect_gitignore only")
            if "respect_gitignore" in value and type(value["respect_gitignore"]) is not bool:
                raise ValueError("Project respect_gitignore must be a boolean")
            rules = value.get("excludes", [])
            if not isinstance(rules, list) or not all(isinstance(rule, str) and 0 < len(rule) <= 2048 for rule in rules):
                raise ValueError("Project excludes must be an array of glob strings")

    def files_for(self, root: Path) -> FileSettings:
        key = os.path.normcase(str(root.resolve()))
        for path, value in self.projects.items():
            if os.path.normcase(str(Path(path).resolve())) == key:
                return FileSettings(tuple(self.files.excludes) + tuple(value.get("excludes", ())),
                    value.get("respect_gitignore", self.files.respect_gitignore))
        return self.files

    def parsing_identity(self, tokenizer_identity: str) -> str:
        return fingerprint({"chunker": 1, "tokens": self.index.chunk_tokens, "tokenizer": tokenizer_identity})
