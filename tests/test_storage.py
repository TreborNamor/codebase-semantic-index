from dataclasses import replace
import sqlite3

import numpy as np
import pytest

from codeconverge.chunking import Chunker
from codeconverge.config import AppPaths
from codeconverge.parsers import ParserLibrary
from codeconverge.scanning import read_source
from codeconverge.storage import ProjectIndex
from codeconverge.tokenization import TokenCounter
from codeconverge.workspace import WorkspaceRoot


def fixture_index(tmp_path):
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    paths = AppPaths(tmp_path / "app")
    root = WorkspaceRoot("a" * 32, source_dir, "source")
    assets = AppPaths.default()
    chunker = Chunker(ParserLibrary(assets.home / "parsers"), TokenCounter(assets.home))
    return paths, root, chunker, ProjectIndex(paths, root, 32, "model-one")


def put(index, root, chunker, name, text):
    (root.path / name).write_text(text, encoding="utf-8")
    source = read_source(root, name, 10000)
    chunks = chunker.chunk(root.project_id, source)
    index.replace_file(source, chunks, chunker.identity)
    return source, chunks


def test_transactional_sources_fts_symbols_vectors_and_restart(tmp_path):
    paths, root, chunker, index = fixture_index(tmp_path)
    source, chunks = put(index, root, chunker, "dashboard.py", "def fetchDashboardMetrics():\n    return 'dashboard analytics'\n")
    row = index.pending()[0]
    vector = np.ones(32, dtype=np.float32) / np.sqrt(32)
    index.put_vectors([(row["id"], chunks[0].key, "cached-vector", vector)])
    assert index.lexical('"dashboard" AND "metrics"', 5, [], ["python"])[0][0] == row["id"]
    assert index.symbols("fetchDashboardMetrics", 5, [], [])[0] == (row["id"], 3)
    assert index.symbols("fetch", 5, [], [])[0][1] == 1
    assert index.semantic(vector, 5, [], [])[0][1] == pytest.approx(1)
    assert index.semantic(vector, 5, ["dashboard.py"], ["python"])[0][0] == row["id"]
    assert index.semantic(vector, 5, ["other/*"], []) == []
    reopened = ProjectIndex(paths, root, 32, "model-one")
    assert reopened.counts() == {"indexed_files": 1, "chunks": 1, "embedded_chunks": 1, "pending_chunks": 0}
    reopened.replace_file(source, chunks, chunker.identity)
    assert reopened.pending() == []
    assert reopened.rows([row["id"]])[row["id"]]["text"] == chunks[0].text
    put(reopened, root, chunker, "dashboard.py", "def deleteUser():\n    return 'remove account'\n")
    assert reopened.lexical('"analytics"', 5, [], []) == []
    assert reopened.symbols("fetchDashboardMetrics", 5, [], []) == []
    assert reopened.counts()["embedded_chunks"] == 0
    reopened.remove_files(["dashboard.py"])
    assert reopened.counts()["chunks"] == 0
    assert reopened.lexical('"account"', 5, [], []) == []


def test_configuration_change_retains_lexical_and_requeues_vectors(tmp_path):
    paths, root, chunker, index = fixture_index(tmp_path)
    _, chunks = put(index, root, chunker, "api.py", "def listUsers():\n    return []\n")
    row = index.pending()[0]
    index.put_vectors([(row["id"], chunks[0].key, "vector", np.ones(32) / np.sqrt(32))])
    changed = ProjectIndex(paths, root, 64, "model-two")
    assert changed.counts()["pending_chunks"] == 1
    assert changed.counts()["embedded_chunks"] == 0
    assert changed.symbols("listUsers", 5, [], [])
    assert changed.warnings


def test_bad_batch_rolls_back_and_stale_embeddings_cannot_attach(tmp_path):
    _, root, chunker, index = fixture_index(tmp_path)
    _, chunks = put(index, root, chunker, "api.py", "def listUsers():\n    return []\n")
    row = index.pending()[0]
    index.put_vectors([(row["id"], "stale-key", "vector", np.ones(32))])
    assert index.counts()["embedded_chunks"] == 0
    with pytest.raises(ValueError):
        index.put_vectors([(row["id"], chunks[0].key, "vector", np.ones(32)),
                           (row["id"], chunks[0].key, "invalid", np.ones(31))])
    assert index.counts()["embedded_chunks"] == 0
    source = read_source(root, "api.py", 10000)
    with pytest.raises(ValueError):
        index.replace_file(source, [replace(chunks[0], workspace_id="b" * 32)], "bad")
    assert index.symbols("listUsers", 5, [], [])


def test_corrupt_database_is_preserved_and_rebuilt(tmp_path):
    paths, root, _, index = fixture_index(tmp_path)
    index.path.write_bytes(b"not a sqlite database")
    recovered = ProjectIndex(paths, root, 32, "model-one")
    assert recovered.counts()["chunks"] == 0
    assert recovered.warnings
    assert list((recovered.directory / "quarantine").glob("*/index.sqlite"))


def test_same_byte_offsets_still_update_parent_and_line_metadata(tmp_path):
    _, root, chunker, index = fixture_index(tmp_path)
    put(index, root, chunker, "api.py", "class Foo:\n    def method(self):\n        return 1\n")
    put(index, root, chunker, "api.py", "class Bar:\n    def method(self):\n        return 1\n")
    assert not index.symbols("Foo.method", 5, [], [])
    assert index.symbols("Bar.method", 5, [], [])
    put(index, root, chunker, "api.py", "#a\n#b\ndef stable():\n    return 1\n")
    previous = index.rows([index.symbols("stable", 1, [], [])[0][0]])
    assert next(iter(previous.values()))["start_line"] == 3
    put(index, root, chunker, "api.py", "#aaaa\ndef stable():\n    return 1\n")
    current = index.rows([index.symbols("stable", 1, [], [])[0][0]])
    assert next(iter(current.values()))["start_line"] == 2
