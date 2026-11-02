"""Explicit parser setup; runtime loads verified local Tree-sitter DLLs only.

Language-pack's convenience API can download missing grammars. It is deliberately
used only in setup. Runtime loading never imports its downloader or calls it.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
from pathlib import Path
import re
import threading

from .assets import verified
from .config import AppPaths

DEFAULT_LANGUAGES = ["python", "javascript", "typescript", "tsx", "vue", "sql", "html", "css",
    "json", "yaml", "toml", "markdown", "go", "rust", "java", "c", "cpp", "csharp", "bash", "ruby", "php"]
ALIASES = {"c_sharp": "csharp", "shell": "bash", "js": "javascript", "ts": "typescript"}


def setup_parsers(paths: AppPaths, languages: list[str] | None = None) -> dict:
    import importlib.metadata
    import tree_sitter_language_pack as pack
    paths.initialize()
    pack.configure(pack.PackConfig(cache_dir=str(paths.home / "parsers")))
    selected = languages or DEFAULT_LANGUAGES
    supported = [name for name in selected if pack.has_language(name)]
    pack.prefetch(supported)
    root = paths.home / "parsers"
    records = {}
    for library in Path(pack.cache_dir()).glob("tree_sitter_*.dll"):
        name = library.stem.removeprefix("tree_sitter_")
        canonical = ALIASES.get(name, name)
        with library.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        records[canonical] = {"path": library.relative_to(root).as_posix(), "sha256": digest,
            "entrypoint": library.stem}
    manifest = {"provider": "tree-sitter-language-pack", "version": importlib.metadata.version("tree-sitter-language-pack"),
        "languages": records, "unsupported": sorted(set(selected) - set(supported))}
    temporary = root / "manifest.json.part"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(root / "manifest.json")
    # Validate actual ABI compatibility while setup errors are actionable.
    loader = ParserLibrary(root)
    for name in supported:
        if loader.parser(name) is None:
            raise RuntimeError(f"Installed parser failed to load: {name}")
    return manifest


class ParserLibrary:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.records = {}
        self.warnings: set[str] = set()
        self._libraries: dict = {}
        self._lock = threading.RLock()
        self._local = threading.local()
        path = self.root / "manifest.json"
        try:
            content = path.read_bytes()
            manifest = json.loads(content)
            self.records = manifest["languages"]
            self.identity = hashlib.sha256(content).hexdigest()
        except (OSError, ValueError, KeyError, TypeError):
            self.identity = "no-cached-parsers"
            self.warnings.add("Parser assets are unavailable; structural text fallbacks are active.")

    def parser(self, language: str):
        from tree_sitter import Language, Parser
        language = ALIASES.get(language, language)
        cache = getattr(self._local, "parsers", None)
        if cache is None:
            cache = self._local.parsers = {}
        if language in cache:
            return cache[language]
        record = self.records.get(language)
        if not isinstance(record, dict):
            self.warnings.add(f"No cached {language} parser; structural fallback is active.")
            cache[language] = None
            return None
        try:
            with self._lock:
                if language not in self._libraries:
                    relative = Path(record["path"])
                    path = (self.root / relative).resolve(strict=True)
                    entrypoint = record["entrypoint"]
                    if relative.is_absolute() or ".." in relative.parts or not path.is_relative_to(self.root):
                        raise ValueError("Parser path escapes application storage")
                    if not re.fullmatch(r"tree_sitter_[a-z0-9_]+", entrypoint):
                        raise ValueError("Invalid parser entry point")
                    if not verified(path, record["sha256"]):
                        raise ValueError("Parser checksum mismatch")
                    library = ctypes.CDLL(str(path))
                    function = getattr(library, entrypoint)
                    function.restype = ctypes.c_void_p
                    function.argtypes = []
                    capsule_new = ctypes.pythonapi.PyCapsule_New
                    capsule_new.restype = ctypes.py_object
                    capsule_new.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p]
                    capsule = capsule_new(function(), b"tree_sitter.Language", None)
                    self._libraries[language] = (library, Language(capsule))
                parser = Parser(self._libraries[language][1])
                cache[language] = parser
                return parser
        except (OSError, ValueError, KeyError, AttributeError, TypeError) as error:
            self.warnings.add(f"Cached {language} parser unavailable: {type(error).__name__}; using structural fallback.")
            cache[language] = None
            return None
