"""Workspace-only discovery, Git ignore rules and stable, bounded source reads."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import stat

from pathspec import GitIgnoreSpec

from .errors import CodeConvergeError
from .settings import FileSettings
from .workspace import WorkspaceRoot, authorized_file

DEFAULT_EXCLUDES = [
    ".venv/", "venv/", "__pycache__/", "node_modules/", "dist/", "build/", "coverage/",
    ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".cache/", ".nuxt/", ".next/",
    ".tox/", ".nox/", ".gradle/", "target/", "vendor/", ".terraform/", ".turbo/",
    ".parcel-cache/", ".svelte-kit/", ".output/", "*.pyc", "*.map", "*.min.js", "*.min.css",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock",
    "Cargo.lock", "Gemfile.lock", "composer.lock", ".codeconverge-index/", ".semantic-index/",
]
BINARY_EXTENSIONS = {".gguf", ".safetensors", ".onnx", ".pt", ".pth", ".pkl", ".pickle", ".npy", ".npz",
    ".db", ".sqlite", ".sqlite3", ".db-wal", ".dll", ".exe", ".pyd", ".so", ".dylib", ".bin", ".o", ".a",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".class", ".woff", ".woff2",
    ".ttf", ".ico", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".pdf", ".docx", ".xlsx", ".pptx",
    ".mp3", ".mp4", ".wav", ".mov", ".avi", ".webm", ".pyc"}
LANGUAGES = {".py": "python", ".pyi": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "javascript", ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
    ".vue": "vue", ".sql": "sql", ".html": "html", ".htm": "html", ".css": "css", ".scss": "css",
    ".json": "json", ".jsonc": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".md": "markdown",
    ".mdx": "markdown", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".cs": "csharp", ".sh": "bash",
    ".bash": "bash", ".rb": "ruby", ".php": "php", ".xml": "html", ".svg": "html", ".txt": "text",
    ".kt": "kotlin", ".kts": "kotlin", ".swift": "swift", ".ex": "elixir", ".exs": "elixir", ".r": "r",
    ".ps1": "powershell", ".psm1": "powershell", ".tf": "hcl", ".tfvars": "hcl"}


def language_for(path: str, text: str = "") -> str:
    suffix = Path(path).suffix.casefold()
    if suffix in LANGUAGES:
        return LANGUAGES[suffix]
    first = text.splitlines()[0] if text else ""
    if first.startswith("#!"):
        if "python" in first:
            return "python"
        if any(name in first for name in ["bash", "/sh", "zsh"]):
            return "bash"
    return suffix.lstrip(".") or "text"


def _physical_path(stream) -> Path:
    if os.name != "nt":
        return Path(os.readlink(f"/proc/self/fd/{stream.fileno()}"))
    import msvcrt
    import win32file
    value = win32file.GetFinalPathNameByHandle(msvcrt.get_osfhandle(stream.fileno()), 0)
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return Path(value)


def _signature(value) -> tuple:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


@dataclass(frozen=True)
class SourceFile:
    relative: str
    language: str
    text: str
    content_hash: str
    size: int
    mtime_ns: int
    inode: str


def read_source(root: WorkspaceRoot, relative: str, max_bytes: int) -> SourceFile:
    path = authorized_file(root, relative)
    # Reject reparse points even when they currently resolve inside the root.
    unresolved = root.path / relative
    if unresolved.is_symlink() or unresolved.is_junction():
        raise CodeConvergeError("UNAUTHORIZED_PATH", "Symlink source entries are excluded.")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
            raise CodeConvergeError("FILE_SKIPPED", "The source file exceeds the configured size limit.")
        physical = _physical_path(stream).resolve()
        if not physical.is_relative_to(root.path):
            raise CodeConvergeError("UNAUTHORIZED_PATH", "The opened file escaped its authorized root.")
        content = stream.read(max_bytes + 1)
        after = os.fstat(stream.fileno())
    if len(content) > max_bytes or _signature(before) != _signature(after) or _signature(after) != _signature(path.stat()):
        raise CodeConvergeError("FILE_CHANGED", "The file changed during reading; retry after the save completes.")
    try:
        if content.startswith((b"\xff\xfe\0\0", b"\0\0\xfe\xff")):
            text = content.decode("utf-32")
        elif content.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = content.decode("utf-16")
        else:
            if b"\0" in content:
                raise UnicodeError("binary data")
            try:
                text = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = content.decode("cp1252")
        if text and sum(ord(c) < 32 and c not in "\n\r\t\f" for c in text) / len(text) > .01:
            raise UnicodeError("binary control characters")
    except UnicodeError as error:
        raise CodeConvergeError("BINARY_FILE", "Binary or unsupported text content was excluded.") from error
    return SourceFile(relative, language_for(relative, text), text, hashlib.sha256(content).hexdigest(),
        len(content), before.st_mtime_ns, f"{before.st_dev}:{before.st_ino}")


class FilePolicy:
    def __init__(self, root: WorkspaceRoot, settings: FileSettings, excluded_storage: tuple[Path, ...]):
        self.root = root
        self.settings = settings
        self.excluded = tuple(path.resolve() for path in excluded_storage)
        self.application = GitIgnoreSpec.from_lines([*DEFAULT_EXCLUDES, *settings.excludes])
        self._git: dict[str, GitIgnoreSpec | None] = {}
        self.warnings: set[str] = set()

    def ignored(self, relative: str, is_directory: bool = False) -> bool:
        path = Path(relative)
        if path.is_absolute() or path.drive or ".." in path.parts or ":" in relative or "\0" in relative:
            return True
        if any(part.casefold() == ".git" for part in path.parts):
            return True
        name = path.name.casefold()
        if name == ".env" or name.startswith(".env."):
            return True
        if not is_directory and path.suffix.casefold() in BINARY_EXTENSIONS:
            return True
        candidate = self.root.path / path
        try:
            if candidate.is_symlink() or candidate.is_junction():
                return True
            physical = candidate.resolve()
            if not physical.is_relative_to(self.root.path) or any(physical == p or physical.is_relative_to(p) for p in self.excluded):
                return True
        except (OSError, ValueError):
            return True
        normalized = path.as_posix() + ("/" if is_directory else "")
        if self.application.match_file(normalized):
            return True
        if not self.settings.respect_gitignore:
            return False
        ignored = False
        parents = [Path(), *list(path.parent.parents)[::-1], path.parent]
        seen = set()
        for parent in parents:
            key = parent.as_posix()
            if key in seen:
                continue
            seen.add(key)
            if key not in self._git:
                spec = None
                try:
                    ignore_path = (parent / ".gitignore").as_posix()
                    ignore = read_source(self.root, ignore_path, 65536).text
                    lines = ignore.splitlines()
                    if len(lines) > 2048:
                        self.warnings.add(f"Ignore-rule limit reached in {ignore_path}.")
                    spec = GitIgnoreSpec.from_lines(lines[:2048])
                except (OSError, CodeConvergeError, ValueError):
                    pass
                self._git[key] = spec
            if self._git[key] is not None:
                subpath = path.relative_to(parent).as_posix() + ("/" if is_directory else "")
                include = self._git[key].check_file(subpath).include
                if include is not None:
                    ignored = include
        return ignored

    def discover(self):
        for directory, dirs, names in os.walk(self.root.path, followlinks=False):
            directory = Path(directory)
            dirs[:] = sorted(name for name in dirs if not self.ignored((directory / name).relative_to(self.root.path).as_posix(), True))
            for name in sorted(names):
                relative = (directory / name).relative_to(self.root.path).as_posix()
                if not self.ignored(relative):
                    yield relative
