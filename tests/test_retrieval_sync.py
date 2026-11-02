"""Lifecycle correctness uses a deterministic test double, never quality claims."""
from dataclasses import replace
import hashlib
import os

import numpy as np
import pytest

from codeconverge.chunking import Chunker
from codeconverge.config import AppPaths
from codeconverge.errors import CodeConvergeError
from codeconverge.parsers import ParserLibrary
from codeconverge.retrieval import Retriever
from codeconverge.settings import EmbeddingSettings, Settings
from codeconverge.storage import ProjectIndex
from codeconverge.synchronization import Synchronizer
from codeconverge.tokenization import TokenCounter
from codeconverge.workspace import Scope, WorkspaceRoot


class TestEmbeddings:
    __test__ = False

    def __init__(self):
        self.cache = {}
        self.inferred = 0
        self.queries = 0

    def key(self, text):
        return hashlib.sha256(text.encode()).hexdigest()

    def embed(self, texts):
        hits = inferred = 0
        for text in texts:
            if self.key(text) in self.cache:
                hits += 1
            else:
                vector = np.zeros(32, dtype=np.float32)
                vector[0 if "dashboard" in text.casefold() else 1] = 1
                self.cache[self.key(text)] = vector
                inferred += 1
        self.inferred += inferred
        return [self.cache[self.key(text)] for text in texts], {"cache_hits": hits, "inferred_texts": inferred, "tokens": 0}

    def query(self, query, counter):
        self.queries += 1
        vector = np.zeros(32, dtype=np.float32)
        vector[0 if "dashboard" in query else 1] = 1
        return vector, False

    def unload_if_idle(self, **kwargs):
        return False

    def status(self):
        return {"identity": "deterministic-test-double", "inferred_texts": self.inferred}


@pytest.fixture
def system(tmp_path):
    paths = AppPaths(tmp_path / "app")
    assets = AppPaths.default()
    settings = replace(Settings(), embedding=replace(EmbeddingSettings(), dimensions=32))
    counter = TokenCounter(assets.home)
    chunker = Chunker(ParserLibrary(assets.home / "parsers"), counter)
    provider = TestEmbeddings()
    roots, indexes = [], {}
    for char in ("a", "b"):
        directory = tmp_path / char / "same-name"
        directory.mkdir(parents=True)
        root = WorkspaceRoot(char * 32, directory, "same-name")
        roots.append(root)
        indexes[root.project_id] = ProjectIndex(paths, root, 32, settings.embedding.identity)
    def sync(root, **kw):
        return Synchronizer(indexes[root.project_id], chunker, provider, settings).run(**kw)
    def search(selected, query, **kw):
        return Retriever(provider, counter, settings).search(Scope("window", 1, True, tuple(selected)), indexes, query, **kw)
    return roots, indexes, provider, sync, search


def test_a_b_a_cache_reuse_and_strict_scope_even_with_cached_b(system):
    (a, b), indexes, provider, sync, search = system
    (a.path / "api.py").write_text("def dashboardFilters():\n    return 'dashboard filters'\n")
    (b.path / "api.py").write_text("def billingReceipt():\n    return 'invoice account'\n")
    assert sync(a)["changed_files"] == 1
    assert sync(b)["changed_files"] == 1
    initial = provider.inferred
    returned = sync(a)
    assert returned["unchanged_files"] == 1
    assert provider.inferred == initial
    assert search([a], "billingReceipt", mode="symbol")["results"] == []
    assert search([b], "dashboardFilters", mode="symbol")["results"] == []
    multi = search([a, b], "billingReceipt", mode="symbol")["results"]
    assert multi[0]["project_id"] == b.project_id
    assert "invoice" in multi[0]["excerpt"]
    assert search([a], "dashboard filters", mode="hybrid")["channels"] == ["lexical", "semantic"]
    before = provider.queries
    assert search([a], "dashboardFilters")["results"][0]["symbol"] == "dashboardFilters"
    assert provider.queries == before  # auto exact definition avoids model inference
    for mode in ("lexical", "semantic", "hybrid"):
        assert search([a], "dashboard filters", mode=mode, paths=["**/*.py"], languages=["py"])["results"]


def test_add_delete_rename_and_changed_same_stat_content(system):
    (a, _), indexes, provider, sync, search = system
    old = a.path / "api.py"
    old.write_text("def listUsers():\n    return 'old'\n")
    sync(a)
    initial = provider.inferred
    new = a.path / "renamed.py"
    old.rename(new)
    stats = sync(a, paths={"api.py", "renamed.py"})
    assert stats["removed_files"] == 1 and stats["cache_hits"] == 1
    assert provider.inferred == initial
    assert search([a], "listUsers", mode="symbol")["results"][0]["path"] == "renamed.py"
    before = new.stat()
    new.write_text("def listUsers():\n    return 'new'\n")
    os.utime(new, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert sync(a, verify=True)["changed_files"] == 1
    assert "new" in search([a], "listUsers", mode="symbol")["results"][0]["excerpt"]
    new.unlink()
    sync(a)
    assert indexes[a.project_id].counts()["chunks"] == 0


def test_search_during_initial_index_and_stale_suppression(system):
    (a, _), indexes, provider, sync, search = system
    path = a.path / "api.py"
    path.write_text("def dashboardFilters():\n    return 'dashboard filters'\n")
    observed = []
    def progress(status):
        if status["phase"] == "embedding":
            observed.append(search([a], "dashboard filters", mode="hybrid"))
    sync(a, progress=progress)
    assert observed[0]["partial"] and observed[0]["results"]
    assert observed[0]["channels"] == ["lexical"]
    assert "fallback" in " ".join(observed[0]["warnings"])
    path.write_text("def changed():\n    return 'saved later'\n")
    stale = []
    assert search([a], "dashboardFilters", mode="symbol", stale=lambda *item: stale.append(item))["results"] == []
    assert stale == [(a.project_id, "api.py")]
    sync(a, paths={"api.py"})
    assert search([a], "changed", mode="symbol")["results"]


def test_ignores_deleted_trees_and_unauthorized_filters(system):
    (a, _), _, _, sync, search = system
    (a.path / "ignored.py").write_text("def sensitive():\n    return 1\n")
    sync(a)
    (a.path / ".gitignore").write_text("ignored.py\n")
    sync(a, paths={".gitignore"})
    assert search([a], "sensitive", mode="symbol")["results"] == []
    for path in ("../other/*", "C:\\other\\*", "/root/*", "\\\\host\\share\\*"):
        with pytest.raises(CodeConvergeError):
            search([a], "x", paths=[path])
    with pytest.raises(CodeConvergeError):
        search([], "x")


def test_cancellation_retains_completed_chunks_for_resume(system):
    (a, _), indexes, _, sync, search = system
    (a.path / "api.py").write_text("def dashboardFilters():\n    return 'dashboard'\n")
    cancelled = False
    def progress(value):
        nonlocal cancelled
        if value["phase"] == "embedding":
            cancelled = True
    result = sync(a, progress=progress, cancelled=lambda: cancelled)
    assert result["cancelled"] and indexes[a.project_id].counts()["pending_chunks"] == 1
    assert search([a], "dashboardFilters", mode="symbol")["results"]
    sync(a)
    assert indexes[a.project_id].counts()["pending_chunks"] == 0
