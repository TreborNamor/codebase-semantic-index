"""Crash-safe per-project SQLite FTS5, symbol and sqlite-vec indexes."""
from __future__ import annotations

from dataclasses import fields
import json
from pathlib import Path
import re
import sqlite3
import threading

import numpy as np

from .chunking import Chunk
from .config import AppPaths
from .database import connection, is_corruption, quarantine, utc_now
from .scanning import SourceFile
from .workspace import WorkspaceRoot

SCHEMA_VERSION = 1


def lexical_text(text: str) -> str:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    separated = re.sub(r"([A-Z])([A-Z][a-z])", r"\1 \2", separated)
    return text + "\n" + separated.replace("_", " ").replace("/", " ")


def chunk_from_row(row) -> Chunk:
    values = {field.name: row[field.name] for field in fields(Chunk)}
    values["aliases"] = tuple(json.loads(values["aliases"]))
    return Chunk(**values)


class ProjectIndex:
    def __init__(self, paths: AppPaths, root: WorkspaceRoot, dimensions: int, embedding_identity: str):
        if not re.fullmatch(r"[a-f0-9]{32}", root.project_id):
            raise ValueError("Invalid project identifier")
        self.paths, self.root, self.dimensions, self.embedding_identity = paths, root, dimensions, embedding_identity
        paths.initialize()
        self.directory = paths.home / "indexes" / root.project_id
        self.directory.mkdir(parents=True, exist_ok=True)
        if self.directory.resolve().parent != (paths.home / "indexes").resolve() or self.directory.is_symlink() or self.directory.is_junction():
            raise ValueError("The project index directory was redirected")
        self.path = self.directory / "index.sqlite"
        self.lock = threading.RLock()
        self.warnings: list[str] = []
        try:
            self._initialize()
        except sqlite3.DatabaseError as error:
            if not is_corruption(error):
                raise
            saved = quarantine(self.path)
            self.warnings.append(f"Index corruption recovered; old files preserved in {saved.name}.")
            self._initialize()
        self.touch()

    def _db(self):
        return connection(self.path, vectors=True)

    def _initialize(self):
        with self.lock, self._db() as db:
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise sqlite3.DatabaseError("Index integrity check failed")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise sqlite3.DatabaseError("Index integrity check: incompatible schema version")
            db.create_function("cc_terms", 1, lexical_text, deterministic=True)
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS files(
                    path TEXT PRIMARY KEY, language TEXT NOT NULL, content_hash TEXT NOT NULL,
                    size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, inode TEXT NOT NULL,
                    parsing_identity TEXT NOT NULL, indexed_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS chunks(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
                    workspace_id TEXT NOT NULL, path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
                    language TEXT NOT NULL, embedded_language TEXT, parent_symbol TEXT, symbol TEXT,
                    qualified_name TEXT, kind TEXT NOT NULL, aliases TEXT NOT NULL,
                    start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
                    start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
                    start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
                    content_hash TEXT NOT NULL, text TEXT NOT NULL, token_count INTEGER NOT NULL,
                    parser TEXT NOT NULL, split_reason TEXT, vector_key TEXT);
                CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
                CREATE INDEX IF NOT EXISTS chunks_symbol ON chunks(symbol COLLATE NOCASE);
                CREATE INDEX IF NOT EXISTS chunks_qualified ON chunks(qualified_name COLLATE NOCASE);
                CREATE INDEX IF NOT EXISTS chunks_language ON chunks(language);
                CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(path,start_byte) WHERE vector_key IS NULL;
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    text, symbols, path, content='', contentless_delete=1,
                    tokenize='porter unicode61 remove_diacritics 2');
            """)
            previous = dict(db.execute("SELECT key,value FROM meta"))
            if previous.get("embedding_identity") != self.embedding_identity or previous.get("dimensions") != str(self.dimensions):
                db.execute("DROP TABLE IF EXISTS chunk_vectors")
                db.execute(f"CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[{self.dimensions}] distance_metric=cosine)")
                db.execute("UPDATE chunks SET vector_key=NULL")
                if previous:
                    self.warnings.append("Embedding configuration changed; lexical data retained and semantic vectors queued for rebuilding.")
            else:
                db.execute("UPDATE chunks SET vector_key=NULL WHERE id NOT IN (SELECT rowid FROM chunk_vectors)")
            db.executescript("""
                CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
                    INSERT INTO chunks_fts(rowid,text,symbols,path) VALUES(new.id,cc_terms(new.text),
                        cc_terms(COALESCE(new.symbol,'') || ' ' || COALESCE(new.parent_symbol,'') || ' ' || new.aliases),cc_terms(new.path));
                END;
                CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
                    DELETE FROM chunks_fts WHERE rowid=old.id;
                    DELETE FROM chunk_vectors WHERE rowid=old.id;
                END;
                CREATE TRIGGER IF NOT EXISTS chunks_update AFTER UPDATE OF text,symbol,parent_symbol,path,aliases ON chunks BEGIN
                    DELETE FROM chunks_fts WHERE rowid=old.id;
                    INSERT INTO chunks_fts(rowid,text,symbols,path) VALUES(new.id,cc_terms(new.text),
                        cc_terms(COALESCE(new.symbol,'') || ' ' || COALESCE(new.parent_symbol,'') || ' ' || new.aliases),cc_terms(new.path));
                END;
            """)
            db.executemany("INSERT OR REPLACE INTO meta VALUES(?,?)", [
                ("embedding_identity", self.embedding_identity), ("dimensions", str(self.dimensions)),
                ("schema_version", str(SCHEMA_VERSION)), ("project_id", self.root.project_id)])
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def touch(self):
        metadata = {**self.root.as_dict(), "schema_version": SCHEMA_VERSION, "dimensions": self.dimensions,
            "embedding_identity": self.embedding_identity, "last_used": utc_now()}
        temporary = self.directory / "project.json.part"
        with self.lock:
            temporary.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            temporary.replace(self.directory / "project.json")

    def files(self) -> dict[str, dict]:
        with self.lock, self._db() as db:
            return {row["path"]: dict(row) for row in db.execute("SELECT * FROM files")}

    def replace_file(self, source: SourceFile, chunks: list[Chunk], parsing_identity: str) -> None:
        if any(chunk.workspace_id != self.root.project_id or chunk.path != source.relative for chunk in chunks):
            raise ValueError("Chunk workspace authority mismatch")
        with self.lock, self._db() as db:
            db.create_function("cc_terms", 1, lexical_text, deterministic=True)
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("""INSERT INTO files VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
                    language=excluded.language,content_hash=excluded.content_hash,size=excluded.size,
                    mtime_ns=excluded.mtime_ns,inode=excluded.inode,parsing_identity=excluded.parsing_identity,indexed_at=excluded.indexed_at""",
                    (source.relative, source.language, source.content_hash, source.size, source.mtime_ns, source.inode, parsing_identity, utc_now()))
                old = {row["key"]: row["id"] for row in db.execute("SELECT id,key FROM chunks WHERE path=?", (source.relative,))}
                columns = [field.name for field in fields(Chunk)]
                marks = ",".join("?" for _ in range(len(columns) + 2))
                for chunk in chunks:
                    if chunk.key in old:
                        old.pop(chunk.key)
                        continue
                    values = [json.dumps(chunk.aliases) if name == "aliases" else getattr(chunk, name) for name in columns]
                    db.execute(f"INSERT INTO chunks(key,qualified_name,{','.join(columns)}) VALUES({marks})", [chunk.key, chunk.qualified_name, *values])
                db.executemany("DELETE FROM chunks WHERE id=?", [(value,) for value in old.values()])
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def remove_files(self, paths: list[str]):
        with self.lock, self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.executemany("DELETE FROM files WHERE path=?", [(path,) for path in paths])
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def observed(self, source: SourceFile):
        """Refresh cheap file metadata after a hash verified an unchanged file."""
        with self.lock, self._db() as db:
            db.execute("UPDATE files SET size=?,mtime_ns=?,inode=? WHERE path=? AND content_hash=?",
                (source.size, source.mtime_ns, source.inode, source.relative, source.content_hash))

    def clear(self):
        with self.lock, self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM files")
                db.execute("DELETE FROM meta WHERE key IN ('last_sync','last_verified')")
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def pending(self, limit: int = 64) -> list[dict]:
        with self.lock, self._db() as db:
            return [dict(row) for row in db.execute("SELECT c.*,f.content_hash AS file_hash FROM chunks c JOIN files f ON f.path=c.path WHERE c.vector_key IS NULL ORDER BY c.path,c.start_byte LIMIT ?", (limit,))]

    def put_vectors(self, values: list[tuple[int, str, str, np.ndarray]]):
        with self.lock, self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for rowid, chunk_key, vector_key, vector in values:
                    current = db.execute("SELECT key FROM chunks WHERE id=?", (rowid,)).fetchone()
                    if not current or current[0] != chunk_key:
                        continue
                    array = np.asarray(vector, dtype="<f4")
                    if array.shape != (self.dimensions,) or not np.isfinite(array).all():
                        raise ValueError("Invalid vector dimensions or values")
                    db.execute("DELETE FROM chunk_vectors WHERE rowid=?", (rowid,))
                    db.execute("INSERT INTO chunk_vectors(rowid,embedding) VALUES(?,?)", (rowid, array.tobytes()))
                    db.execute("UPDATE chunks SET vector_key=? WHERE id=?", (vector_key, rowid))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def counts(self) -> dict:
        with self.lock, self._db() as db:
            return {"indexed_files": db.execute("SELECT count(*) FROM files").fetchone()[0],
                "chunks": db.execute("SELECT count(*) FROM chunks").fetchone()[0],
                "embedded_chunks": db.execute("SELECT count(*) FROM chunk_vectors").fetchone()[0],
                "pending_chunks": db.execute("SELECT count(*) FROM chunks WHERE vector_key IS NULL").fetchone()[0]}

    def metadata(self) -> dict:
        with self.lock, self._db() as db:
            return dict(db.execute("SELECT key,value FROM meta"))

    def set_metadata(self, **values):
        with self.lock, self._db() as db:
            db.executemany("INSERT OR REPLACE INTO meta VALUES(?,?)", [(key, str(value)) for key, value in values.items()])

    def rows(self, ids: list[int]) -> dict[int, dict]:
        if not ids:
            return {}
        with self.lock, self._db() as db:
            marks = ",".join("?" for _ in ids)
            return {row["id"]: dict(row) for row in db.execute(f"SELECT c.*,f.content_hash AS file_hash FROM chunks c JOIN files f ON c.path=f.path WHERE c.id IN ({marks})", ids)}

    @staticmethod
    def _filters(paths: list[str], languages: list[str]) -> tuple[str, list]:
        clauses, values = [], []
        if paths:
            clauses.append("(" + " OR ".join("c.path GLOB ?" for _ in paths) + ")")
            values.extend(paths)
        if languages:
            marks = ",".join("?" for _ in languages)
            clauses.append(f"(c.language IN ({marks}) OR c.embedded_language IN ({marks}))")
            values.extend([*languages, *languages])
        return (" AND " + " AND ".join(clauses) if clauses else ""), values

    def lexical(self, match: str, limit: int, paths: list[str], languages: list[str]) -> list[tuple[int, float]]:
        filters, values = self._filters(paths, languages)
        with self.lock, self._db() as db:
            return [(row[0], -row[1]) for row in db.execute(f"""SELECT c.id,bm25(chunks_fts,1,4,2) AS relevance
                FROM chunks_fts JOIN chunks c ON chunks_fts.rowid=c.id
                WHERE chunks_fts MATCH ? {filters} ORDER BY relevance,c.id LIMIT ?""", [match, *values, limit])]

    def symbols(self, name: str, limit: int, paths: list[str], languages: list[str]) -> list[tuple[int, float]]:
        filters, values = self._filters(paths, languages)
        escaped = name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        with self.lock, self._db() as db:
            # JSON aliases are queried as data, not interpreted SQL or MATCH.
            rows = db.execute(f"""SELECT c.id,c.symbol,c.qualified_name,c.start_byte,
                CASE WHEN c.symbol=? COLLATE NOCASE OR c.qualified_name=? COLLATE NOCASE THEN 3
                     WHEN EXISTS(SELECT 1 FROM json_each(c.aliases) WHERE value=? COLLATE NOCASE) THEN 2 ELSE 1 END AS precision
                FROM chunks c WHERE (c.symbol LIKE ? ESCAPE '\\' OR c.qualified_name LIKE ? ESCAPE '\\'
                     OR EXISTS(SELECT 1 FROM json_each(c.aliases) WHERE value LIKE ? ESCAPE '\\'))
                     {filters} ORDER BY precision DESC,c.start_byte,c.id LIMIT ?""",
                [name, name, name, escaped + "%", escaped + "%", escaped + "%", *values, limit])
            return [(row["id"], float(row["precision"])) for row in rows]

    def semantic(self, vector: np.ndarray, limit: int, paths: list[str], languages: list[str]) -> list[tuple[int, float]]:
        vector = np.asarray(vector, dtype="<f4")
        if vector.shape != (self.dimensions,):
            raise ValueError("Query embedding configuration changed; retry search")
        filters, values = self._filters(paths, languages)
        with self.lock, self._db() as db:
            if not filters:
                rows = db.execute("SELECT rowid,distance FROM chunk_vectors WHERE embedding MATCH ? AND k=? ORDER BY distance", (vector.tobytes(), limit))
            else:
                # Filters precede ranking, preserving recall even when the
                # unrestricted nearest neighbors all belong to another path.
                rows = db.execute(f"""SELECT c.id,vec_distance_cosine(v.embedding,?) AS distance
                    FROM chunks c JOIN chunk_vectors v ON v.rowid=c.id WHERE 1=1 {filters}
                    ORDER BY distance,c.id LIMIT ?""", [vector.tobytes(), *values, limit])
            return [(row[0], 1 - float(row[1])) for row in rows]
