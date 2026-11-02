"""Application entry points. Source roots are never inferred here."""

from __future__ import annotations

import argparse
import json

from . import __version__
from .config import AppPaths


def main() -> None:
    parser = argparse.ArgumentParser(prog="codeconverge")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("engine", "ensure-engine", "mcp", "engine-info", "stop-engine"):
        commands.add_parser(name)
    setup = commands.add_parser("setup")
    setup.add_argument("--model-only", action="store_true")
    setup.add_argument("--offline", action="store_true", help="Verify existing assets without any downloader")
    setup.add_argument("--languages", nargs="+", help="Additional supported Tree-sitter grammars to cache during setup")
    args = parser.parse_args()
    paths = AppPaths.default()
    if args.command == "engine":
        from .ipc import serve
        serve(paths)
    elif args.command == "ensure-engine":
        from .ipc import ensure_engine
        result = ensure_engine(paths)
        print(json.dumps({**result, "pipe": paths.pipe_name, "home": str(paths.home)}))
    elif args.command == "engine-info":
        print(json.dumps({"pipe": paths.pipe_name, "home": str(paths.home), "version": __version__}))
    elif args.command == "stop-engine":
        from .ipc import PipeClient
        from .errors import CodeConvergeError
        try:
            with PipeClient(paths, timeout=1) as client:
                print(json.dumps(client.call("shutdown")))
        except CodeConvergeError as error:
            if error.code != "ENGINE_UNAVAILABLE":
                raise
            print(json.dumps({"already_stopped": True}))
    elif args.command == "mcp":
        from .mcp_server import main as serve_mcp
        serve_mcp()
    elif args.command == "setup":
        from filelock import FileLock
        paths.initialize()
        with FileLock(str(paths.home / "config" / "setup.lock"), timeout=300):
            if args.offline:
                from .assets import MODEL_FILE, MODEL_SHA256, MODEL_SIZE, TOKENIZER_FILE, TOKENIZER_SHA256, verified
                from .parsers import DEFAULT_LANGUAGES, ParserLibrary
                if not verified(paths.home / "models" / MODEL_FILE, MODEL_SHA256, MODEL_SIZE):
                    raise RuntimeError("Missing or corrupt model; run online setup once")
                if not args.model_only:
                    if not verified(paths.home / "models" / TOKENIZER_FILE, TOKENIZER_SHA256):
                        raise RuntimeError("Missing or corrupt Qwen tokenizer")
                    parsers = ParserLibrary(paths.home / "parsers")
                    for language in [*DEFAULT_LANGUAGES, *(args.languages or [])]:
                        if parsers.parser(language) is None:
                            raise RuntimeError(f"Missing or corrupt parser: {language}")
                print(json.dumps({"offline_assets_verified": True}))
            else:
                from .assets import setup_model, setup_tokenizer
                setup_model(paths)
                if not args.model_only:
                    from .parsers import DEFAULT_LANGUAGES, setup_parsers
                    setup_tokenizer(paths)
                    manifest = setup_parsers(paths, list(dict.fromkeys([*DEFAULT_LANGUAGES, *(args.languages or [])])))
                    print(json.dumps({"parsers": sorted(manifest["languages"]), "unsupported": manifest["unsupported"]}))
