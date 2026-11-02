import os
import subprocess
import sys
import time

import pytest
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from codeconverge.config import AppPaths
from codeconverge.errors import CodeConvergeError
from codeconverge.ipc import PipeClient


@pytest.fixture
def live_engine(tmp_path):
    paths = AppPaths(tmp_path / "app")
    environment = {**os.environ, "CODECONVERGE_HOME": str(paths.home)}
    process = subprocess.Popen([sys.executable, "-m", "codeconverge", "engine"], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        with PipeClient(paths, timeout=10) as client:
            assert client.call("ping")["product"] == "CodeConverge"
        yield paths, process
    finally:
        process.terminate()
        process.wait(timeout=10)


@pytest.mark.windows
async def test_real_stdio_mcp_and_named_pipe_window_isolation(tmp_path, live_engine):
    paths, process = live_engine
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(); b.mkdir()
    (a / "a.py").write_text("def alpha_beacon():\n    return 'alpha-only'\n")
    (b / "b.py").write_text("def beta_beacon():\n    return 'beta-only'\n")
    with PipeClient(paths) as editor_a, PipeClient(paths) as editor_b:
        session_a = editor_a.call("open_session", roots=[{"path": str(a)}], trusted=True)
        session_b = editor_b.call("open_session", roots=[{"path": str(b)}], trusted=True)
        env = {**os.environ, "CODECONVERGE_HOME": str(paths.home), "CODECONVERGE_SESSION_ID": session_a["session_id"], "CODECONVERGE_SESSION_TOKEN": session_a["mcp_token"]}
        async with Client(StdioServerParameters(command=sys.executable, args=["-m", "codeconverge", "mcp"], env=env)) as mcp:
            tools = await mcp.list_tools()
            assert {item.name for item in tools.tools} == {"index_status", "search_code", "find_symbol", "refresh_index", "manage_index"}
            for tool in tools.tools:
                assert tool.annotations.read_only_hint is (tool.name in {"index_status", "search_code", "find_symbol"})
                assert tool.annotations.open_world_hint is False
                assert not ({"root", "roots", "workspace_path", "session_id", "token"} & tool.input_schema.get("properties", {}).keys())
            managed = await mcp.call_tool("manage_index", {"action": "list"})
            assert not managed.is_error and "projects" in str(managed)
            refreshed = await mcp.call_tool("refresh_index", {"full_rebuild": False})
            assert not refreshed.is_error and "incremental_sync" in str(refreshed)
            result = await mcp.call_tool("find_symbol", {"name": "alpha_beacon"})
            assert not result.is_error
            assert "alpha-only" in str(result)
            result = await mcp.call_tool("find_symbol", {"name": "beta_beacon"})
            assert "beta-only" not in str(result)
            editor_a.call("update_session", session_id=session_a["session_id"], control_token=session_a["control_token"], roots=[{"path": str(b)}], trusted=True)
            deadline = time.monotonic() + 5
            while True:
                result = await mcp.call_tool("find_symbol", {"name": "beta_beacon"})
                if "beta-only" in str(result):
                    break
                assert time.monotonic() < deadline
                import asyncio
                await asyncio.sleep(.05)
            assert "beta-only" in str(result)
            result = await mcp.call_tool("find_symbol", {"name": "alpha_beacon"})
            assert "alpha-only" not in str(result)
        status_b = editor_b.call("call_tool", session_id=session_b["session_id"], token=session_b["mcp_token"], tool="index_status")
        assert status_b["roots"][0]["path"] == str(b)
    # Losing the control pipe revokes its capability even if an MCP proxy lives.
    with PipeClient(paths) as observer:
        deadline = time.monotonic() + 2
        while True:
            try:
                observer.call("call_tool", session_id=session_a["session_id"], token=session_a["mcp_token"], tool="index_status")
            except CodeConvergeError as error:
                assert error.code == "INVALID_SESSION"
                break
            assert time.monotonic() < deadline
            time.sleep(.01)


@pytest.mark.windows
def test_engine_exits_without_editors_despite_diagnostic_pipe_traffic(tmp_path):
    paths = AppPaths(tmp_path / "idle-app")
    paths.initialize()
    (paths.home / "config/settings.toml").write_text("[index]\nengine_idle_seconds=1\n", encoding="utf-8")
    environment = {**os.environ, "CODECONVERGE_HOME": str(paths.home)}
    process = subprocess.Popen([sys.executable, "-I", "-m", "codeconverge", "engine"], env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        with PipeClient(paths, timeout=10) as client:
            assert client.call("ping")["editor_sessions"] == 0
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            try:
                with PipeClient(paths, timeout=.1) as client:
                    client.call("ping")
            except CodeConvergeError:
                pass
            time.sleep(.1)
        assert process.poll() == 0, "Diagnostics must not keep an editorless engine alive"
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
