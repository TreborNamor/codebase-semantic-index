"""Structural source chunks with original byte/line locations and symbol metadata."""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re

from .parsers import ParserLibrary
from .scanning import SourceFile
from .settings import fingerprint
from .tokenization import TokenCounter

FUNCTIONS = {"function_definition", "function_declaration", "generator_function_declaration", "method_definition",
    "method_declaration", "constructor_declaration", "function_item", "local_function_statement", "arrow_function"}
CLASSES = {"class_definition", "class_declaration", "class_specifier", "interface_declaration", "struct_item",
    "struct_specifier", "enum_declaration", "impl_item", "trait_item", "record_declaration"}
VARIABLES = {"lexical_declaration", "variable_declaration", "variable_declarator", "const_item", "static_item",
    "assignment", "type_alias_declaration", "type_item", "field_declaration", "public_field_definition"}
WRAPPERS = {"decorated_definition", "export_statement", "declaration"}


@dataclass(frozen=True)
class Chunk:
    workspace_id: str
    path: str
    language: str
    embedded_language: str | None
    parent_symbol: str | None
    symbol: str | None
    kind: str
    aliases: tuple[str, ...]
    start_line: int
    end_line: int
    start_column: int
    end_column: int
    start_byte: int
    end_byte: int
    content_hash: str
    text: str
    token_count: int
    parser: str
    split_reason: str | None = None

    @property
    def qualified_name(self) -> str | None:
        return f"{self.parent_symbol}.{self.symbol}" if self.parent_symbol and self.symbol else self.symbol

    @property
    def key(self) -> str:
        # Metadata can change without moving bytes or changing a method's own
        # text (a same-length parent rename or preceding newline edit). Such
        # changes must replace the row; content-addressed embeddings still reuse
        # identical inference text independently of this row identity.
        return fingerprint([self.workspace_id, self.path, self.language, self.embedded_language,
            self.parent_symbol, self.symbol, self.kind, self.aliases, self.start_byte, self.end_byte,
            self.start_line, self.end_line, self.start_column, self.end_column, self.content_hash,
            self.token_count, self.parser, self.split_reason])

    @property
    def embedding_text(self) -> str:
        # Paths and line offsets are ranked separately. Moving unchanged code
        # can reuse its embedding. Source-derived parent names add context.
        parent = "Vue component" if self.language == "vue" else self.parent_symbol
        if parent and len(parent.encode("utf-8")) > 32:
            parent = None
        context = f"\nParent: {parent}" if parent else ""
        return f"Language: {self.embedded_language or self.language}{context}\n{self.text}"


class Chunker:
    def __init__(self, parsers: ParserLibrary, counter: TokenCounter, budget: int = 384):
        self.parsers, self.counter, self.budget = parsers, counter, budget
        self.identity = fingerprint({"version": 3, "parsers": parsers.identity, "tokenizer": counter.identity, "budget": budget})

    def chunk(self, workspace_id: str, source: SourceFile) -> list[Chunk]:
        return _Document(self, workspace_id, source).run()


class _Document:
    def __init__(self, chunker: Chunker, workspace_id: str, source: SourceFile):
        self.chunker, self.workspace_id, self.source = chunker, workspace_id, source
        self.data = source.text.encode("utf-8")
        self.lines = [0, *[match.end() for match in re.finditer(b"\n", self.data)]]
        self.result: list[Chunk] = []
        self.partial_parse = False

    def text(self, start: int, end: int) -> str:
        return self.data[start:end].decode("utf-8")

    def count(self, start: int, end: int) -> int:
        return self.chunker.counter.count(self.text(start, end))

    def name(self, node, base: int = 0) -> str | None:
        current = node
        for _ in range(12):
            for field in ["name", "declarator", "key"]:
                child = current.child_by_field_name(field)
                if child:
                    if child.type in {"identifier", "type_identifier", "field_identifier", "property_identifier", "bare_key", "string"}:
                        return self.text(base + child.start_byte, base + child.end_byte).strip("\"'")
                    current = child
                    break
            else:
                children = current.named_children
                if current.type in VARIABLES and children:
                    current = children[0]
                    continue
                return None
        return None

    def unwrap(self, node):
        while node.type in WRAPPERS:
            definition = node.child_by_field_name("definition") or node.child_by_field_name("declaration")
            if definition is None:
                definition = next((c for c in node.named_children if c.type in FUNCTIONS | CLASSES | VARIABLES), None)
            if definition is None or definition == node:
                break
            node = definition
        return node

    def describe(self, node, start: int, end: int, base: int):
        actual = self.unwrap(node)
        name = self.name(actual, base)
        kind = "function" if actual.type in FUNCTIONS else "class" if actual.type in CLASSES else "variable" if actual.type in VARIABLES else "source"
        text = self.text(start, end)
        aliases = []
        if self.source.language == "sql":
            match = re.search(r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"`\[\]]+)", text, re.I)
            if match:
                name, kind = match[2].strip('"`[]'), match[1].casefold()
                if "." in name:
                    aliases.append(name.rsplit(".", 1)[-1])
        if self.source.language in {"json", "yaml", "toml"} and not name:
            match = re.match(r"\s*[\[\"']?([\w.\-]+)[\]\"']?\s*(?:[:=]|$)", text.splitlines()[0])
            if match:
                name, kind = match[1], "configuration"
        if actual.type in {"atx_heading", "setext_heading"}:
            name, kind = text.splitlines()[0].lstrip("# ").strip(), "heading"
        for method, route in re.findall(r"@\w+(?:\.\w+)*\.(get|post|put|patch|delete|options|head)\(\s*['\"]([^'\"]+)['\"]", text[:4096], re.I):
            aliases.extend([f"{method.upper()} {route}", route])
        if actual.type in {"import_statement", "import_from_statement", "import_declaration", "use_declaration"}:
            kind = "imports"
        return actual, name, kind, tuple(dict.fromkeys(aliases))

    def emit(self, start, end, symbol, parent, kind, aliases, parser, embedded=None, reason=None):
        if parser == "tree_sitter" and self.partial_parse:
            parser = "tree_sitter_partial"
        while start < end and self.data[start:start + 1] in (b"\n", b"\r"):
            start += 1
        while end > start and self.data[end - 1:end] in (b"\n", b"\r", b" ", b"\t"):
            end -= 1
        if end <= start:
            return
        text = self.text(start, end)
        if not re.search(r"\w", text):
            return
        first = bisect_right(self.lines, start)
        last = bisect_right(self.lines, end - 1)
        self.result.append(Chunk(self.workspace_id, self.source.relative, self.source.language, embedded, parent,
            symbol, kind, aliases, first, last, start - self.lines[first - 1], end - self.lines[last - 1],
            start, end, hashlib.sha256(text.encode()).hexdigest(), text, self.chunker.counter.count(text), parser, reason))

    def pieces(self, node, start: int, end: int, base: int = 0, depth: int = 0):
        if self.count(start, end) <= self.chunker.budget:
            yield start, end, None
            return
        children = [] if node is None else [c for c in node.named_children if base + c.end_byte > start and base + c.start_byte < end]
        body = node.child_by_field_name("body") if node is not None else None
        if body is not None and base + body.start_byte >= start and base + body.end_byte <= end:
            children = body.named_children or children
        boundaries = sorted({start, end, *[base + c.start_byte for c in children if start < base + c.start_byte < end]})
        if len(boundaries) > 2 and depth < 64:
            parts = []
            for a, b in zip(boundaries, boundaries[1:]):
                child = next((c for c in children if base + c.start_byte <= a < base + c.end_byte), None)
                parts.extend(self.pieces(child, a, b, base, depth + 1))
            begin, finish, reason = parts[0]
            for a, b, why in parts[1:]:
                if self.count(begin, b) <= self.chunker.budget:
                    finish = b
                    reason = reason or why
                else:
                    yield begin, finish, reason or "structural_split"
                    begin, finish, reason = a, b, why
            yield begin, finish, reason or "structural_split"
            return
        if children and depth < 64 and children[0] != node:
            child = next((c for c in children if base + c.start_byte <= start and base + c.end_byte >= end), None)
            if child is not None:
                yield from self.pieces(child, start, end, base, depth + 1)
                return
        # One indivisible leaf (for example a long SQL literal or JSON string).
        text = self.text(start, end)
        for a, b in self.chunker.counter.windows(text, self.chunker.budget):
            yield start + len(text[:a].encode()), start + len(text[:b].encode()), "oversized_leaf"

    def walk(self, nodes, parent=None, base=0, embedded=None):
        for node in nodes:
            start, end = base + node.start_byte, base + node.end_byte
            actual, symbol, kind, aliases = self.describe(node, start, end, base)
            body = actual.child_by_field_name("body")
            nested = body is not None and any(self.unwrap(c).type in FUNCTIONS | CLASSES for c in body.named_children)
            if (actual.type in CLASSES or actual.type in FUNCTIONS and nested) and body is not None and body.named_children:
                header_end = base + body.named_children[0].start_byte
                for a, b, reason in self.pieces(None, start, header_end):
                    self.emit(a, b, symbol, parent, kind, aliases, "tree_sitter", embedded, reason)
                qualified = f"{parent}.{symbol}" if parent and symbol else symbol or parent
                yield_nodes = body.named_children
                self.walk(yield_nodes, qualified, base, embedded)
            else:
                for a, b, reason in self.pieces(actual, start, end, base):
                    self.emit(a, b, symbol, parent, kind, aliases, "tree_sitter", embedded, reason)

    def vue(self, root):
        component = Path(self.source.relative).stem
        for node in root.named_children:
            if node.type == "script_element":
                raw = next((c for c in node.named_children if c.type == "raw_text"), None)
                if raw is None:
                    continue
                header = self.text(node.start_byte, raw.start_byte)
                language = "typescript" if re.search(r"lang\s*=\s*['\"](?:ts|typescript)['\"]", header) else "javascript"
                parser = self.chunker.parsers.parser(language)
                if parser:
                    tree = parser.parse(self.data[raw.start_byte:raw.end_byte])
                    self.partial_parse |= tree.root_node.has_error
                    self.walk(tree.root_node.named_children, component, raw.start_byte, language)
                else:
                    self.fallback(raw.start_byte, raw.end_byte, component, language)
            else:
                embedded = "css" if node.type == "style_element" else "html"
                for a, b, reason in self.pieces(node, node.start_byte, node.end_byte):
                    self.emit(a, b, component, None, "component" if embedded == "html" else "style", (), "tree_sitter", embedded, reason)

    def fallback(self, start: int, end: int, parent=None, embedded=None):
        text = self.text(start, end)
        # Declaration/paragraph boundaries keep unsupported languages useful
        # without pretending a parser ran. Budget splitting is a final fallback.
        matches = list(re.finditer(r"(?m)^(?:[ \t]*(?:(?:async\s+)?def|class|function|fn|func|sub|procedure)\s+([\w$]+)|#{1,6}\s+(.+)$)|\n[ \t]*\n", text))
        cuts = sorted({0, len(text), *[m.start() for m in matches]})
        for a, b in zip(cuts, cuts[1:]):
            value = text[a:b]
            symbol_match = re.match(r"\s*(?:(?:async\s+)?def|class|function|fn|func|sub|procedure)\s+([\w$]+)", value)
            symbol = symbol_match[1] if symbol_match else None
            absolute_a = start + len(text[:a].encode())
            absolute_b = start + len(text[:b].encode())
            for x, y, reason in self.pieces(None, absolute_a, absolute_b):
                self.emit(x, y, symbol, parent, "source", (), "structural_fallback", embedded, reason)

    def run(self):
        if not self.data.strip():
            return []
        parser = self.chunker.parsers.parser(self.source.language)
        if parser:
            tree = parser.parse(self.data)
            self.partial_parse = tree.root_node.has_error
            if self.source.language == "vue":
                self.vue(tree.root_node)
            else:
                self.walk(tree.root_node.named_children)
        else:
            self.fallback(0, len(self.data))
        unique = {}
        for chunk in self.result:
            unique.setdefault((chunk.start_byte, chunk.end_byte, chunk.symbol), chunk)
        return sorted(unique.values(), key=lambda c: (c.start_byte, c.end_byte))
