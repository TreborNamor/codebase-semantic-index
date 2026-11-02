from test_manager import engine, open_project, call, eventually


def test_engine_returns_actual_lines_and_enforces_scope(tmp_path, engine):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    (a / "code.py").write_text("def alpha_handler():\n    return 'alpha-only'\n", encoding="utf-8")
    (b / "code.py").write_text("def beta_handler():\n    return 'beta-only'\n", encoding="utf-8")
    session = engine.dispatch("editor-a", {"op": "open_session", "roots": [{"path": str(a)}], "trusted": True})
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    result = engine.dispatch("mcp", {"op": "call_tool", "session_id": session["session_id"], "token": session["mcp_token"], "tool": "find_symbol", "arguments": {"name": "alpha_handler"}})
    match = result["results"][0]
    assert match["start_line"] == 1
    assert match["end_line"] == 2
    assert match["uri"] == (a / "code.py").as_uri()
    assert "alpha-only" in match["excerpt"]
    missing = engine.dispatch("mcp", {"op": "call_tool", "session_id": session["session_id"], "token": session["mcp_token"], "tool": "find_symbol", "arguments": {"name": "beta_handler"}})
    assert missing["results"] == []


def test_engine_excludes_app_storage_and_dependencies_under_opened_ancestor(tmp_path, engine):
    app = engine.paths.home
    (app / "cache" / "not_source.py").write_text("def forbidden_beacon():\n    return 'private-cache'\n")
    dependencies = tmp_path / "node_modules"
    dependencies.mkdir()
    (dependencies / "dep.py").write_text("def forbidden_beacon():\n    return 'dependency'\n")
    (tmp_path / "valid.py").write_text("def valid_beacon():\n    return 1\n")
    session = engine.dispatch("editor", {"op": "open_session", "roots": [{"path": str(tmp_path)}], "trusted": True})
    eventually(lambda: call(engine, session, "index_status")["readiness"] == "ready")
    def lookup(name):
        return engine.dispatch("mcp", {"op": "call_tool", "session_id": session["session_id"], "token": session["mcp_token"], "tool": "find_symbol", "arguments": {"name": name}})
    assert not lookup("forbidden_beacon")["results"]
    assert len(lookup("valid_beacon")["results"]) == 1
