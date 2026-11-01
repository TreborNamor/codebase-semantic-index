const path = require('node:path');

function mockVscode() {
  class Uri {
    constructor(scheme, authority, pathname) { this.scheme = scheme; this.authority = authority; this.path = pathname; this.query = ''; this.fragment = ''; }
    static parse(value) { const u = new URL(value); return new Uri(u.protocol.slice(0, -1), u.host, decodeURIComponent(u.pathname)); }
    static file(value) { return new Uri('file', '', value.replace(/\\/g, '/')); }
    static joinPath(base, ...parts) { return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...parts)); }
    with(change) { return Object.assign(new Uri(this.scheme, this.authority, this.path), this, change); }
    toString() { return `${this.scheme}://${this.authority}${this.path}`; }
    get fsPath() { return this.path; }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) { this.start = typeof a === 'number' ? new Position(a, b) : a; this.end = typeof a === 'number' ? new Position(c, d) : b; }
  }
  class CancellationError extends Error { constructor() { super('Canceled'); this.name = 'Canceled'; } }
  class CancellationTokenSource {
    constructor() {
      this.listeners = new Set();
      this.token = { isCancellationRequested: false, onCancellationRequested: cb => { this.listeners.add(cb); return { dispose: () => this.listeners.delete(cb) }; } };
    }
    cancel() { this.token.isCancellationRequested = true; for (const cb of this.listeners) cb(); }
    dispose() { this.listeners.clear(); }
  }
  const files = new Map(), textDocuments = [], settings = new Map();
  class FileSystemError extends Error {
    constructor(message, code) { super(message); this.code = code; }
    static FileNotFound() { return new FileSystemError('File not found', 'FileNotFound'); }
  }
  const missing = () => FileSystemError.FileNotFound();
  const uriKey = uri => uri.toString();
  function regexGlob(glob) {
    if (glob.startsWith('{') && glob.endsWith('}')) return new RegExp(glob.slice(1, -1).split(',').map(p => regexGlob(p).source).join('|'));
    let source = '^';
    for (let i = 0; i < glob.length; i++) {
      if (glob.slice(i, i + 3) === '**/') { source += '(?:.*/)?'; i += 2; }
      else if (glob.slice(i, i + 2) === '**') { source += '.*'; i++; }
      else if (glob[i] === '*') source += '[^/]*';
      else if (glob[i] === '?') source += '[^/]';
      else source += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(source + '$');
  }
  const workspace = {
    workspaceFolders: [], textDocuments,
    getConfiguration(section, root) { return { get: (key, fallback) => settings.get((root?.toString() ?? '*') + ':' + section + '.' + key) ?? settings.get('*:' + section + '.' + key) ?? fallback }; },
    async findFiles(pattern, exclude, max) {
      const root = pattern.baseUri ?? pattern.base;
      const prefix = root.toString().replace(/\/$/, '') + '/';
      return [...files.keys()].filter(key => key.startsWith(prefix))
        .filter(key => regexGlob(pattern.pattern).test(key.slice(prefix.length)))
        .filter(key => !exclude || !regexGlob(exclude).test(key.slice(prefix.length)))
        .slice(0, max ?? Infinity).map(Uri.parse);
    },
    async openTextDocument(uri) {
      const existing = textDocuments.find(doc => doc.uri.toString() === uri.toString());
      return existing ?? document(uri, new TextDecoder().decode(await workspace.fs.readFile(uri)), false);
    },
    fs: {
      async stat(uri) {
        const bytes = files.get(uriKey(uri));
        if (bytes) return { type: 1, size: bytes.length, mtime: 1, ctime: 1 };
        if ([...files.keys()].some(key => key.startsWith(uriKey(uri).replace(/\/$/, '') + '/'))) return { type: 2, size: 0, mtime: 1, ctime: 1 };
        throw missing();
      },
      async readFile(uri) { const bytes = files.get(uriKey(uri)); if (!bytes) throw missing(); return bytes.slice(); },
      async writeFile(uri, bytes) { files.set(uriKey(uri), bytes.slice()); },
      async createDirectory() {},
      async rename(from, to) { if (!files.has(uriKey(from))) throw missing(); files.set(uriKey(to), files.get(uriKey(from))); files.delete(uriKey(from)); },
      async delete(uri) { if (!files.delete(uriKey(uri))) throw missing(); },
      async readDirectory(uri) {
        const prefix = uri.toString().replace(/\/$/, '') + '/';
        return [...files.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(key => [key.slice(prefix.length), 1]);
      },
    },
  };
  function document(uri, initial, dirty = true) {
    let text = initial;
    const doc = {
      uri, isDirty: dirty, version: 1, languageId: 'typescript', isClosed: false,
      get lineCount() { return text.split(/\r\n|\r|\n/).length; },
      getText(range) { if (!range) return text; return text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)); },
      lineAt(line) { return { text: text.split(/\r\n|\r|\n/)[line] }; },
      offsetAt(position) { const lines = [...text.matchAll(/\r\n|\r|\n/g)]; return (position.line ? lines[position.line - 1].index + lines[position.line - 1][0].length : 0) + position.character; },
      positionAt(offset) { const prefix = text.slice(0, offset).split(/\r\n|\r|\n/); return new Position(prefix.length - 1, prefix.at(-1).length); },
      setText(value, dirty = true) { text = value; doc.version++; doc.isDirty = dirty; },
    };
    return doc;
  }
  const vscode = {
    Uri, Range, Position, CancellationError, CancellationTokenSource, FileSystemError,
    RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.base = base; this.pattern = pattern; } },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace, commands: { executeCommand: async () => [] },
    LanguageModelToolResult: class { constructor(content) { this.content = content; } },
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  };
  function addFile(root, file, text) { const uri = Uri.joinPath(root, file); files.set(uri.toString(), new TextEncoder().encode(text)); return uri; }
  function addRoot(uri, name) { workspace.workspaceFolders.push({ uri, name, index: workspace.workspaceFolders.length }); }
  return { vscode, files, settings, document, addFile, addRoot };
}
module.exports = { mockVscode };
