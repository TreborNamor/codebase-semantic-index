const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers.cjs');

function offset(text, line, character) {
  const breaks = [...text.matchAll(/\r\n|\r|\n/g)];
  return (line ? breaks[line - 1].index + breaks[line - 1][0].length : 0) + character;
}
function assertCoverage(text, chunks, max = 1024) {
  const seen = new Uint8Array(text.length);
  for (const chunk of chunks) {
    const start = offset(text, chunk.range.start, chunk.range.startCharacter);
    const end = offset(text, chunk.range.end, chunk.range.endCharacter);
    assert.equal(text.slice(start, end), chunk.text, 'range must identify exactly the embedded source');
    assert.ok(chunk.text.length <= max, 'oversized code is split, never truncated');
    seen.fill(1, start, end);
  }
  for (let i = 0; i < text.length; i++) {
    if (/\S/.test(text[i])) assert.equal(seen[i], 1, `missing non-whitespace source at ${i}`);
  }
}

test('long leaf functions keep their middle and tail and retain symbol context', () => {
  const { splitSource } = loadTs('src/chunkCoverage.ts');
  const signature = 'function handleMessage() {';
  const text = signature + '\n' + Array.from({ length: 150 }, (_, i) => `  executeStep${i}();`).join('\n') + '\n  return finalTailResult;\n}';
  const chunks = splitSource(text, 'src/handler.ts', [{ start: 0, end: text.length, name: 'Controller.handleMessage', context: signature }]);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.some(c => c.text.includes('finalTailResult')));
  assert.ok(chunks.every(c => c.symbolName === 'Controller.handleMessage' && c.context === signature));
  assertCoverage(text, chunks);
});

test('symbol regions do not omit imports, module glue, tiny functions, or trailing code', () => {
  const { splitSource } = loadTs('src/chunkCoverage.ts');
  const text = 'import { run } from "./runner";\nsetup();\nfunction f() { run(); }\nbootstrap();\n';
  const start = text.indexOf('function');
  const end = text.indexOf('\nbootstrap');
  const chunks = splitSource(text, 'main.ts', [{ start, end, name: 'f' }]);
  assert.ok(chunks.some(c => c.text.includes('import')));
  assert.ok(chunks.some(c => c.text.includes('bootstrap')));
  assert.ok(chunks.some(c => c.symbolName === 'f'));
  assertCoverage(text, chunks);
});

test('nested symbols select qualified child names while keeping all parent code', () => {
  const { splitSource } = loadTs('src/chunkCoverage.ts');
  const text = 'class C {\n  value = 1;\n  method() { return this.value; }\n}\n';
  const start = text.indexOf('method');
  const end = text.indexOf('\n}');
  const chunks = splitSource(text, 'c.ts', [
    { start: 0, end: text.trimEnd().length, name: 'C' },
    { start, end, name: 'C.method' },
  ]);
  assert.ok(chunks.some(c => c.symbolName === 'C.method'));
  assertCoverage(text, chunks);
});

test('single long lines, CRLF, Unicode, and tiny files have exact bounded ranges', () => {
  const { splitSource } = loadTs('src/chunkCoverage.ts');
  for (const text of ['x();', 'const payload = "' + 'a😀'.repeat(1800) + '";\r\nfinish();\r\n', 'a();\rb();\r' + 'z();\r'.repeat(400), '  \r\n']) {
    assertCoverage(text, splitSource(text, 'long.ts'));
  }
});

function document(text) {
  const state = { text, version: 1 };
  return Object.assign(state, {
    uri: { path: '/repo/main.ts' },
    getText: () => state.text,
    offsetAt: position => offset(state.text, position.line, position.character),
  });
}
function chunker(provider) {
  return loadTs('src/chunker.ts', {
    vscode: { commands: { executeCommand: provider } },
    './utils': { relativeWorkspacePath: () => 'main.ts' },
  });
}

test('failed symbol providers still index every current source region', async () => {
  const doc = document('import "setup";\n' + 'execute();\n'.repeat(400));
  const { chunkDocument } = chunker(async () => { throw new Error('provider unavailable'); });
  assertCoverage(doc.text, await chunkDocument(doc, {}));
});

test('a buffer edited while symbols resolve cannot receive stale symbol ranges', async () => {
  const doc = document('old();');
  const { chunkDocument } = chunker(async () => {
    doc.text = 'newUnsavedContents();';
    doc.version++;
    return [{ name: 'old', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, children: [] }];
  });
  const chunks = await chunkDocument(doc, {});
  assertCoverage(doc.text, chunks);
  assert.equal(chunks[0].symbolName, undefined);
  assert.equal(chunks[0].text, doc.text);
});
