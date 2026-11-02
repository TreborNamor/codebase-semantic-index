"""Local SQLite connections and bounded recovery of derived cache files."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connection(path: Path, *, vectors: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("PRAGMA cache_size=-8192")
        if vectors:
            import sqlite_vec
            db.enable_load_extension(True)
            try:
                sqlite_vec.load(db)
            finally:
                db.enable_load_extension(False)
        yield db
    finally:
        db.close()


def quarantine(path: Path) -> Path:
    """Move only known SQLite files within their resolved cache directory."""
    parent = path.parent.resolve()
    if path.is_symlink() or path.resolve().parent != parent:
        raise ValueError("Refusing to recover a redirected cache path")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target = parent / "quarantine" / f"{path.stem}-{stamp}"
    target.mkdir(parents=True, exist_ok=False)
    if not target.resolve().is_relative_to(parent):
        raise ValueError("Recovery directory escaped application storage")
    for suffix in ["", "-wal", "-shm"]:
        source = Path(str(path) + suffix)
        destination = target / source.name
        if source.exists():
            if source.is_symlink() or source.resolve().parent != parent or destination.resolve().parent != target.resolve():
                raise ValueError("Unsafe cache recovery path")
            source.replace(destination)
    return target


def is_corruption(error: Exception) -> bool:
    return any(text in str(error).casefold() for text in ["malformed", "not a database", "disk image", "integrity check"])
