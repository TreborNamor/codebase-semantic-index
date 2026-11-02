"""Length-prefixed JSON over current-user-only Windows named pipes.

No pickle, shell, sockets, or workspace paths inferred from process state.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import struct
import subprocess
import sys
import threading
import time
from logging.handlers import RotatingFileHandler

from .config import AppPaths
from . import __version__
from .errors import CodeConvergeError

MAX_FRAME = 8 * 1024 * 1024


def _modules():
    if sys.platform != "win32":
        raise RuntimeError("This CodeConverge release supports Windows local workspaces only.")
    import pywintypes
    import win32api
    import win32con
    import win32event
    import win32file
    import win32pipe
    import win32security
    return pywintypes, win32api, win32con, win32event, win32file, win32pipe, win32security


def _read_exact(handle, count: int) -> bytes:
    *_, win32file, win32pipe, win32security = _modules()
    parts = []
    remaining = count
    while remaining:
        _, data = win32file.ReadFile(handle, remaining)
        if not data:
            raise EOFError("Pipe closed")
        parts.append(data)
        remaining -= len(data)
    return b"".join(parts)


def read_frame(handle) -> dict:
    length, = struct.unpack("<I", _read_exact(handle, 4))
    if not 0 < length <= MAX_FRAME:
        raise CodeConvergeError("INVALID_FRAME", "Invalid named-pipe frame size.")
    value = json.loads(_read_exact(handle, length))
    if not isinstance(value, dict):
        raise CodeConvergeError("INVALID_FRAME", "Engine messages must be JSON objects.")
    return value


def write_frame(handle, value: dict) -> None:
    *_, win32file, win32pipe, win32security = _modules()
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_FRAME:
        raise CodeConvergeError("INVALID_FRAME", "Named-pipe message exceeds the size limit.")
    win32file.WriteFile(handle, struct.pack("<I", len(body)) + body)


class PipeClient:
    def __init__(self, paths: AppPaths, timeout: float = 10):
        pywintypes, _, con, _, file, pipe, _ = _modules()
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.handle = file.CreateFile(paths.pipe_name, con.GENERIC_READ | con.GENERIC_WRITE, 0, None, con.OPEN_EXISTING, 0, None)
                break
            except (OSError, pywintypes.error):
                if time.monotonic() >= deadline:
                    raise CodeConvergeError("ENGINE_UNAVAILABLE", "CodeConverge's editor-managed engine is not running.")
                time.sleep(.05)
        self._lock = threading.Lock()

    def call(self, op: str, **values) -> dict:
        with self._lock:
            write_frame(self.handle, {"id": 1, "op": op, **values})
            response = read_frame(self.handle)
        if "error" in response:
            raise CodeConvergeError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def close(self):
        self.handle.Close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def ensure_engine(paths: AppPaths) -> dict:
    try:
        with PipeClient(paths, timeout=.1) as client:
            running = client.call("ping")
            if running.get("version") == __version__:
                return running
            if running.get("editor_sessions", 1):
                raise CodeConvergeError("UPGRADE_REQUIRED", "An earlier CodeConverge engine is still in use. Close VS Code windows, stop the old engine and reopen VS Code.")
            client.call("shutdown")
        time.sleep(.5)
    except CodeConvergeError as error:
        if error.code != "ENGINE_UNAVAILABLE":
            raise
    paths.initialize()
    environment = os.environ.copy()
    environment["CODECONVERGE_HOME"] = str(paths.home)
    with (paths.home / "logs" / "bootstrap.log").open("ab") as log:
        subprocess.Popen([sys.executable, "-I", "-m", "codeconverge", "engine"], env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP, close_fds=True)
    with PipeClient(paths, timeout=15) as client:
        return client.call("ping")


def serve(paths: AppPaths) -> None:
    pywintypes, api, con, event, file, pipe, security = _modules()
    paths.initialize()
    handler = RotatingFileHandler(paths.home / "logs" / "engine.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(message)s")
    mutex = event.CreateMutex(None, True, paths.mutex_name)
    if api.GetLastError() == 183:
        mutex.Close()
        return
    from .engine import Engine
    engine = Engine(paths)
    token = security.OpenProcessToken(api.GetCurrentProcess(), con.TOKEN_QUERY)
    user_sid = security.GetTokenInformation(token, security.TokenUser)[0]
    sid = security.ConvertSidToStringSid(user_sid)
    token.Close()
    descriptor = security.ConvertStringSecurityDescriptorToSecurityDescriptor(f"D:P(A;;GA;;;{sid})(A;;GA;;;SY)", security.SDDL_REVISION_1)
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = descriptor

    def handle_connection(handle):
        owner = secrets.token_hex(16)
        try:
            while True:
                request = read_frame(handle)
                try:
                    result = engine.dispatch(owner, request)
                    response = {"id": request.get("id"), "result": result}
                except CodeConvergeError as exc:
                    response = {"id": request.get("id"), "error": exc.as_dict()}
                except (KeyError, TypeError, ValueError) as exc:
                    response = {"id": request.get("id"), "error": {"code": "INVALID_REQUEST", "message": "Malformed engine request."}}
                except Exception:
                    logging.exception("Engine operation failed")
                    response = {"id": request.get("id"), "error": {"code": "INTERNAL_ERROR", "message": "Engine operation failed. See local diagnostics."}}
                write_frame(handle, response)
        except (OSError, pywintypes.error, EOFError, ValueError, CodeConvergeError):
            pass
        finally:
            engine.close_owner(owner)
            handle.Close()

    logging.info("CodeConverge engine started pid=%s", os.getpid())
    stopping = threading.Event()
    def idle_monitor():
        while not stopping.wait(.5):
            if engine.idle:
                stopping.set()
                # Wake the blocking accept without introducing a listener or
                # abandoning a thread blocked on ConnectNamedPipe.
                try:
                    with PipeClient(paths, timeout=1) as wake:
                        wake.call("ping")
                except (OSError, CodeConvergeError):
                    pass
                return
    threading.Thread(target=idle_monitor, name="codeconverge-idle", daemon=True).start()
    try:
        while not stopping.is_set():
            handle = pipe.CreateNamedPipe(paths.pipe_name, pipe.PIPE_ACCESS_DUPLEX, pipe.PIPE_TYPE_BYTE | pipe.PIPE_READMODE_BYTE | pipe.PIPE_WAIT | 0x8, 32, 65536, 65536, 5000, attributes)
            try:
                pipe.ConnectNamedPipe(handle, None)
            except pywintypes.error as exc:
                if exc.winerror != 535:  # Client connected before ConnectNamedPipe.
                    handle.Close()
                    raise
            threading.Thread(target=handle_connection, args=(handle,), daemon=True).start()
    finally:
        stopping.set()
        engine.close()
        event.ReleaseMutex(mutex)
        mutex.Close()
