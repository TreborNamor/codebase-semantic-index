from pathlib import Path

import pytest

from codeconverge.errors import CodeConvergeError
from codeconverge.workspace import WorkspaceRegistry, authorized_file


@pytest.fixture
def projects(tmp_path):
    a, b = tmp_path / "a" / "same", tmp_path / "b" / "same"
    a.mkdir(parents=True)
    b.mkdir(parents=True)
    (a / "only_a.py").write_text("def project_a():\n    return 'A'\n")
    (b / "only_b.py").write_text("def project_b():\n    return 'B'\n")
    return a, b


def test_independent_windows_and_same_folder_names(tmp_path, projects):
    registry = WorkspaceRegistry("host", tmp_path / "app")
    a, b = projects
    sa = registry.open("window-a", [{"path": str(a)}], True)
    sb = registry.open("window-b", [{"path": str(b)}], True)
    assert sa["roots"][0]["project_id"] != sb["roots"][0]["project_id"]
    assert registry.scope(sa["session_id"], sa["mcp_token"]).roots[0].path == a
    with pytest.raises(CodeConvergeError, match="capability"):
        registry.scope(sa["session_id"], sb["mcp_token"])
    registry.close_owner("window-a")
    with pytest.raises(CodeConvergeError):
        registry.scope(sa["session_id"], sa["mcp_token"])
    assert registry.scope(sb["session_id"], sb["mcp_token"]).roots[0].path == b


def test_switch_reopen_multi_root_and_revoke_inflight(tmp_path, projects):
    registry = WorkspaceRegistry("host", tmp_path / "app")
    a, b = projects
    session = registry.open("window", [{"path": str(a)}], True)
    old = registry.scope(session["session_id"], session["mcp_token"])
    registry.update(session["session_id"], session["control_token"], [{"path": str(b)}], True)
    with pytest.raises(CodeConvergeError, match="changed"):
        registry.verify_current(old)
    registry.update(session["session_id"], session["control_token"], [{"path": str(a)}, {"path": str(b)}], True)
    current = registry.scope(session["session_id"], session["mcp_token"])
    assert current.roots[0].project_id == old.roots[0].project_id
    assert len(current.roots) == 2


def test_no_workspace_or_untrusted_never_grants_installation(tmp_path, projects):
    registry = WorkspaceRegistry("host", tmp_path / "app")
    for trusted, expected in [(True, "NO_ACTIVE_WORKSPACE"), (False, "UNTRUSTED_WORKSPACE")]:
        session = registry.open("window", [], trusted)
        with pytest.raises(CodeConvergeError) as exc:
            registry.scope(session["session_id"], session["mcp_token"]).require_roots()
        assert exc.value.code == expected
    a, _ = projects
    session = registry.open("window", [{"path": str(a)}], False)
    assert registry.scope(session["session_id"], session["mcp_token"]).roots == ()


@pytest.mark.parametrize("relative", ["../b/only_b.py", "C:\\outside.py", "only_a.py:secret", "\\outside.py"])
def test_rejects_unauthorized_paths(tmp_path, projects, relative):
    a, _ = projects
    registry = WorkspaceRegistry("host", tmp_path / "app")
    session = registry.open("window", [{"path": str(a)}], True)
    root = registry.scope(session["session_id"], session["mcp_token"]).roots[0]
    with pytest.raises(CodeConvergeError):
        authorized_file(root, relative)


def test_failed_replacement_revokes_old_roots(tmp_path, projects):
    a, _ = projects
    registry = WorkspaceRegistry("host", tmp_path / "app")
    session = registry.open("window", [{"path": str(a)}], True)
    with pytest.raises(CodeConvergeError):
        registry.update(session["session_id"], session["control_token"], [{"path": str(tmp_path / "missing")}], True)
    assert not registry.scope(session["session_id"], session["mcp_token"]).roots


def test_directory_symlink_cannot_escape_authorized_root(tmp_path, projects):
    a, b = projects
    link = a / "escape"
    link.symlink_to(b, target_is_directory=True)
    registry = WorkspaceRegistry("host", tmp_path / "app")
    session = registry.open("window", [{"path": str(a)}], True)
    root = registry.scope(session["session_id"], session["mcp_token"]).roots[0]
    with pytest.raises(CodeConvergeError) as exc:
        authorized_file(root, "escape/only_b.py")
    assert exc.value.code == "UNAUTHORIZED_PATH"


def test_installation_storage_cannot_be_granted_as_source(tmp_path):
    application = tmp_path / "app"
    application.mkdir()
    registry = WorkspaceRegistry("host", application)
    with pytest.raises(CodeConvergeError) as exc:
        registry.open("window", [{"path": str(application)}], True)
    assert exc.value.code == "INSTALLATION_ROOT"
