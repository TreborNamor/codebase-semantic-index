from dataclasses import replace
import time

import pytest

from codeconverge.config import AppPaths
from codeconverge.engine import Engine
from codeconverge.errors import CodeConvergeError
from codeconverge.manager import IndexManager
from codeconverge.settings import Settings
from test_retrieval_sync import TestEmbeddings


def eventually(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(.025)
    raise AssertionError("Background operation did not complete")


@pytest.fixture
def engine(tmp_path):
    paths = AppPaths(tmp_path / "app")
    settings = replace(Settings(), embedding=replace(Settings().embedding, dimensions=32),
        index=replace(Settings().index, debounce_ms=50, reconcile_seconds=1, verify_seconds=1))
    manager = IndexManager(paths, settings, embeddings=TestEmbeddings())
    value = Engine(paths, manager=manager)
    try:
        yield value
    finally:
        value.close()


def open_project(engine, path, owner="editor"):
    path.mkdir(exist_ok=True)
    return engine.dispatch(owner, {"op": "open_session", "roots": [{"path": str(path)}], "trusted": True})


def call(engine, session, tool, **args):
    return engine.dispatch("proxy", {"op": "call_tool", "session_id": session["session_id"], "token": session["mcp_token"], "tool": tool, "arguments": args})


def control(engine, session, op, owner="editor", **args):
    return engine.dispatch(owner, {"op": op, "session_id": session["session_id"], "control_token": session["control_token"], **args})


def test_automatic_activation_events_reconcile_and_shared_watcher_lease(engine, tmp_path):
    a = tmp_path / "project"
    a.mkdir()
    (a / "api.py").write_text("def dashboardFilters():\n    return 'dashboard'\n")
    first = open_project(engine, a)
    second = open_project(engine, a, "second")
    eventually(lambda: call(engine, first, "index_status")["readiness"] == "ready")
    assert call(engine, first, "find_symbol", name="dashboardFilters")["results"]
    one = control(engine, first, "editor_status")["projects"][0]
    two = control(engine, second, "editor_status", owner="second")["projects"][0]
    assert one["watch_owner"] == two["watch_owner"]
    assert one["watch_owner"] == first["session_id"]  # new windows never preempt a live watcher
    assert one["totals"]["inferred_texts"] == 1
    engine.close_owner("editor")
    assert control(engine, second, "editor_status", owner="second")["projects"][0]["watch_owner"] == second["session_id"]
    (a / "api.py").write_text("def updatedFilters():\n    return 'dashboard update'\n")
    control(engine, second, "file_events", owner="second", project_id=one["project_id"], paths=["api.py"])
    eventually(lambda: call(engine, second, "find_symbol", name="updatedFilters")["results"])
    (a / "missed.py").write_text("def missedEvent():\n    return 'saved without notification'\n")
    eventually(lambda: call(engine, second, "find_symbol", name="missedEvent")["results"])
    assert not call(engine, second, "find_symbol", name="dashboardFilters")["results"]


def test_confirmations_cannot_be_approved_by_mcp_other_window_or_after_switch(engine, tmp_path):
    session = open_project(engine, tmp_path / "a")
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    request = call(engine, session, "refresh_index", full_rebuild=True)
    assert request["confirmation_required"]
    with pytest.raises(CodeConvergeError):
        engine.dispatch("proxy", {"op": "confirm_maintenance", "session_id": session["session_id"], "control_token": session["mcp_token"], "request_id": request["request_id"], "approved": True})
    with pytest.raises(CodeConvergeError):
        control(engine, session, "confirm_maintenance", owner="different-connection", request_id=request["request_id"], approved=True)
    assert control(engine, session, "editor_status")["confirmations"]
    assert control(engine, session, "confirm_maintenance", request_id=request["request_id"], approved=False)["cancelled"]
    request = call(engine, session, "refresh_index", full_rebuild=True)
    control(engine, session, "update_session", roots=[], trusted=True)
    with pytest.raises(CodeConvergeError):
        control(engine, session, "confirm_maintenance", request_id=request["request_id"], approved=True)
    assert call(engine, session, "index_status")["readiness"] == "no_active_workspace"


def test_switch_return_reuses_cache_and_cached_deletion_requires_confirmation(engine, tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    (a / "api.py").write_text("def alpha():\n    return 1\n")
    (b / "api.py").write_text("def beta():\n    return 2\n")
    session = open_project(engine, a)
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    original = call(engine, session, "index_status")["projects"][0]
    control(engine, session, "update_session", roots=[{"path": str(b)}], trusted=True)
    eventually(lambda: call(engine, session, "find_symbol", name="beta")["results"])
    assert not call(engine, session, "find_symbol", name="alpha")["results"]
    control(engine, session, "update_session", roots=[{"path": str(a)}], trusted=True)
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    returned = call(engine, session, "index_status")["projects"][0]
    assert returned["project_id"] == original["project_id"]
    assert returned["totals"]["inferred_texts"] == original["totals"]["inferred_texts"]
    cached = call(engine, session, "manage_index")["projects"]
    inactive = next(p for p in cached if p["path"] == str(b))
    proposal = call(engine, session, "manage_index", action="delete", project_id=inactive["project_id"])
    assert (engine.paths.home / "indexes" / inactive["project_id"]).exists()
    control(engine, session, "confirm_maintenance", request_id=proposal["request_id"], approved=True)
    assert not (engine.paths.home / "indexes" / inactive["project_id"]).exists()
    with pytest.raises(CodeConvergeError, match="Close"):
        call(engine, session, "manage_index", action="delete", project_id=original["project_id"])


def test_runtime_index_corruption_recovers_without_reembedding_unchanged_content(engine, tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "api.py").write_text("def recoverable():\n    return 1\n")
    session = open_project(engine, root)
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    project = next(iter(engine.manager.projects.values()))
    inferred = engine.manager.embeddings.inferred
    project.index.path.write_bytes(b"corrupt index")
    assert call(engine, session, "index_status")["readiness"] == "indexing"
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    assert call(engine, session, "find_symbol", name="recoverable")["results"]
    assert engine.manager.embeddings.inferred == inferred
