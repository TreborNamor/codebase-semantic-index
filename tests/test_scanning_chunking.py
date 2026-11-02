from pathlib import Path

import pytest

from codeconverge.chunking import Chunker
from codeconverge.config import AppPaths
from codeconverge.errors import CodeConvergeError
from codeconverge.parsers import ParserLibrary
from codeconverge.scanning import FilePolicy, read_source
from codeconverge.settings import FileSettings
from codeconverge.tokenization import TokenCounter
from codeconverge.workspace import WorkspaceRoot


def root_for(path):
    return WorkspaceRoot("a" * 32, path.resolve(), "project")


def test_discovery_without_git_keeps_tests_sql_config_and_untracked(tmp_path):
    for name in ["api.py", "test_api.py", "schema.sql", "settings.toml", "notes.md", "untracked.ts", ".env", ".env.local", "package-lock.json"]:
        (tmp_path / name).write_text("source = 1\n")
    for name in ["node_modules", ".venv", ".git", "dist"]:
        directory = tmp_path / name
        directory.mkdir()
        (directory / "secret.py").write_text("source = 1\n")
    found = set(FilePolicy(root_for(tmp_path), FileSettings(), ()).discover())
    assert found == {"api.py", "test_api.py", "schema.sql", "settings.toml", "notes.md", "untracked.ts"}


def test_nested_gitignore_negation_and_global_project_rules(tmp_path):
    (tmp_path / ".gitignore").write_text("*.tmp\nignored/\n")
    (tmp_path / "kept.tmp").write_text("ignored")
    nested = tmp_path / "src"
    nested.mkdir()
    (nested / ".gitignore").write_text("!keep.tmp\n")
    for name in ["keep.tmp", "drop.tmp", "source.py"]:
        (nested / name).write_text("text")
    (tmp_path / "ignored").mkdir()
    (tmp_path / "ignored" / "code.py").write_text("text")
    policy = FilePolicy(root_for(tmp_path), FileSettings(("src/source.py",)), ())
    found = set(policy.discover())
    assert "src/keep.tmp" in found
    assert not {"src/drop.tmp", "kept.tmp", "src/source.py", "ignored/code.py"} & found


def test_binary_size_app_storage_symlink_and_utf16(tmp_path):
    root = root_for(tmp_path)
    (tmp_path / "binary.txt").write_bytes(b"a\0b\0garbage")
    with pytest.raises(CodeConvergeError) as error:
        read_source(root, "binary.txt", 1000)
    assert error.value.code == "BINARY_FILE"
    (tmp_path / "schema.sql").write_bytes("CREATE TABLE users(id INT);\r\n".encode("utf-16"))
    assert read_source(root, "schema.sql", 1000).language == "sql"
    assert "CREATE TABLE users" in read_source(root, "schema.sql", 1000).text
    storage = tmp_path / "application"
    storage.mkdir()
    (storage / "cache.py").write_text("cached_source=1")
    alias = tmp_path / "alias"
    alias.symlink_to(storage, target_is_directory=True)
    assert not {"application/cache.py", "alias/cache.py"} & set(FilePolicy(root, FileSettings(), (storage,)).discover())
    (tmp_path / "large.py").write_text("x" * 2000)
    with pytest.raises(CodeConvergeError):
        read_source(root, "large.py", 1000)


@pytest.fixture
def chunker():
    paths = AppPaths.default()
    parsers = ParserLibrary(paths.home / "parsers")
    if parsers.parser("python") is None:
        pytest.skip("Run codeconverge setup to install parser assets")
    return Chunker(parsers, TokenCounter(paths.home), budget=64)


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_decorators_classes_large_functions_and_exact_locations(tmp_path, chunker, newline):
    text = '@router.get("/dashboard/filters")\ndef update_filters(value: str):\n    """Refresh selected dashboard filters."""\n' + ''.join(f'    selected_{i} = transform(value, {i})\n' for i in range(35))
    text += '\nclass Controller:\n    def save(self):\n        return True\n'
    text = text.replace("\n", newline)
    (tmp_path / "api.py").write_text(text, encoding="utf-8", newline="")
    chunks = chunker.chunk("a", read_source(root_for(tmp_path), "api.py", 100000))
    definitions = [c for c in chunks if c.symbol == "update_filters"]
    assert len(definitions) > 1
    assert definitions[0].start_line == 1 and '@router.get' in definitions[0].text
    assert all("GET /dashboard/filters" in c.aliases for c in definitions)
    assert all(c.token_count <= 64 for c in chunks)
    method = next(c for c in chunks if c.symbol == "save")
    assert method.parent_symbol == "Controller"
    for chunk in chunks:
        raw = text.encode()[chunk.start_byte:chunk.end_byte].decode()
        assert raw == chunk.text
        assert text.encode()[:chunk.start_byte].count(b"\n") + 1 == chunk.start_line
        assert text.encode()[:chunk.end_byte - 1].count(b"\n") + 1 == chunk.end_line


def test_vue_template_typescript_state_and_sql_definitions(tmp_path, chunker):
    text = '<template>\n<template v-if="selected"><div>{{ selected }}</div></template>\n</template>\n<script setup lang="ts">\nimport {ref} from "vue"\nconst selected = ref([])\nfunction updateDashboardFilters(value: string[]) { selected.value = value }\n</script>\n'
    (tmp_path / "Dashboard.vue").write_text(text, encoding="utf-8")
    chunks = chunker.chunk("a", read_source(root_for(tmp_path), "Dashboard.vue", 100000))
    method = next(c for c in chunks if c.symbol == "updateDashboardFilters")
    assert method.start_line == 7 and method.embedded_language == "typescript" and method.language == "vue"
    assert method.parent_symbol == "Dashboard"
    assert any(c.symbol == "selected" for c in chunks)
    assert any(c.kind == "component" and '<template v-if' in c.text for c in chunks)
    (tmp_path / "schema.sql").write_text("CREATE TABLE accounts (id INTEGER PRIMARY KEY);\nCREATE VIEW active_accounts AS SELECT * FROM accounts;\n")
    sql = chunker.chunk("a", read_source(root_for(tmp_path), "schema.sql", 100000))
    assert {c.symbol for c in sql} == {"accounts", "active_accounts"}


def test_token_windows_do_not_break_unicode_or_exceed_budget(chunker):
    text = ('dashboard 東京🙂 filter ' * 100)
    windows = list(chunker.counter.windows(text, 48))
    assert ''.join(text[a:b] for a,b in windows) == text
    assert all(chunker.counter.count(text[a:b]) <= 48 for a,b in windows)


def test_parser_runtime_is_offline_even_for_missing_language(monkeypatch):
    import socket
    def deny(*args, **kwargs):
        raise AssertionError("Unexpected parser network access")
    monkeypatch.setattr(socket, "socket", deny)
    loader = ParserLibrary(AppPaths.default().home / "parsers")
    parser = loader.parser("python")
    if parser is None:
        pytest.skip("Parser setup required")
    assert parser.parse(b"def hello():\n    return 1\n").root_node.type == "module"
    assert loader.parser("deliberately_not_installed_language") is None
