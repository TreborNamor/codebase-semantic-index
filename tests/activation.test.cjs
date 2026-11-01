const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers.cjs');
const { mockVscode } = require('./mockVscode.cjs');

function event() {
  const handlers = new Set();
  const register = callback => { handlers.add(callback); return { dispose: () => handlers.delete(callback) }; };
  register.fire = value => { for (const callback of handlers) callback(value); };
  register.size = () => handlers.size;
  return register;
}

function setup(git) {
  const env = mockVscode();
  const { vscode } = env;
  const roots = [vscode.Uri.parse('file:///workspace'), vscode.Uri.parse('vscode-remote://other-host/workspace')];
  roots.forEach((root, index) => env.addRoot(root, `root-${index}`));
  const scheduled = [], documentsChanged = [], documentsClosed = [], commands = new Map(), tools = [];
  let synced = 0, workerStarted = 0, panelOpened = 0, built = 0;
  const disposable = () => ({ dispose() {} });
  const lifecycle = {
    onDidChangeWorkspaceFolders: event(), onDidChangeConfiguration: event(),
    onDidChangeTextDocument: event(), onDidSaveTextDocument: event(), onDidCloseTextDocument: event(),
  };
  const watcher = { onDidCreate: event(), onDidChange: event(), onDidDelete: event(), dispose() {} };
  Object.assign(vscode.workspace, lifecycle, { createFileSystemWatcher: () => watcher });
  vscode.window = { registerWebviewViewProvider: disposable };
  vscode.commands.registerCommand = (name, callback) => { commands.set(name, callback); return disposable(); };
  vscode.lm = { registerTool: (name, value) => { tools.push({ name, value }); return disposable(); } };
  vscode.extensions = { getExtension: name => { assert.equal(name, 'vscode.git'); return git; } };
  const workspaceIndex = {
    schedule: uri => scheduled.push(uri.toString()),
    syncWorkspaceFolders: () => synced++,
    onDocumentChanged: doc => documentsChanged.push(doc), onDocumentClosed: doc => documentsClosed.push(doc),
    dispose() {},
  };
  class PanelProvider { static viewType = 'panel'; }
  class WorkerProvider { static viewType = 'worker'; }
  const { activate } = loadTs('src/extension.ts', {
    vscode,
    './panelManager': { CodebaseSemanticIndexViewProvider: PanelProvider, openPanel: async () => { panelOpened++; }, openPromptRefiner: async () => { panelOpened++; }, buildAll: async () => { built++; } },
    './embeddingWorker': { initEmbeddingWorker: () => workerStarted++, CodebaseSemanticIndexWorkerProvider: WorkerProvider },
    './searchTool': { CodebaseSemanticIndexTool: class {} }, './workspaceIndex': { workspaceIndex },
  });
  const context = { subscriptions: [] };
  activate(context);
  return { ...env, roots, scheduled, documentsChanged, documentsClosed, lifecycle, watcher, context, commands, tools,
    get synced() { return synced; }, get workerStarted() { return workerStarted; }, get panelOpened() { return panelOpened; }, get built() { return built; } };
}

test('activation registers the existing tool and commands and reconciles roots on startup/add/remove', async () => {
  const e = setup();
  assert.equal(e.synced, 1);
  assert.equal(e.workerStarted, 1);
  assert.equal(e.tools[0].name, 'codebase_semantic_index_search');
  assert.ok(e.context.subscriptions.includes(e.watcher));
  e.addRoot(e.vscode.Uri.parse('file:///second'), 'second');
  e.lifecycle.onDidChangeWorkspaceFolders.fire({ added: [], removed: [] });
  assert.equal(e.synced, 2);
  e.vscode.workspace.workspaceFolders.shift();
  e.lifecycle.onDidChangeWorkspaceFolders.fire({ added: [], removed: [] });
  assert.equal(e.synced, 3);
  await e.commands.get('codebaseSemanticIndex.buildIndex')();
  assert.equal(e.panelOpened, 1);
  assert.equal(e.built, 1);
  await e.commands.get('codebaseSemanticIndex.refinePrompt')();
  assert.equal(e.panelOpened, 2);
});

test('dirty changes, save, and close are forwarded to the transient document layer', () => {
  const e = setup();
  const doc = e.document(e.vscode.Uri.joinPath(e.roots[0], 'main.ts'), 'const current = true;');
  e.lifecycle.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] });
  e.lifecycle.onDidSaveTextDocument.fire(doc);
  e.lifecycle.onDidCloseTextDocument.fire(doc);
  assert.deepEqual(e.documentsChanged, [doc, doc]);
  assert.deepEqual(e.documentsClosed, [doc]);
});

test('file/ignore/checkout events schedule only the matching full workspace URI', () => {
  const e = setup();
  for (const [name, eventName] of [['src/main.ts', 'onDidChange'], ['.gitignore', 'onDidCreate'], ['.git/HEAD', 'onDidChange'], ['.git/index', 'onDidChange'], ['.git/refs/heads/feature', 'onDidChange'], ['src/deleted.ts', 'onDidDelete']]) {
    e.watcher[eventName].fire(e.vscode.Uri.joinPath(e.roots[0], name));
  }
  assert.equal(e.scheduled.length, 6);
  assert.ok(e.scheduled.every(key => key === e.roots[0].toString()));
  e.watcher.onDidChange.fire(e.vscode.Uri.joinPath(e.roots[1], 'src/remote.ts'));
  assert.equal(e.scheduled.at(-1), e.roots[1].toString());
  e.watcher.onDidChange.fire(e.vscode.Uri.parse('file:///workspace-other/src/main.ts'));
  e.watcher.onDidChange.fire(e.vscode.Uri.parse('vscode-remote://third-host/workspace/src/main.ts'));
  assert.equal(e.scheduled.length, 7);
});

test('own persisted writes and irrelevant Git metadata cannot cause rebuild loops', () => {
  const e = setup();
  for (const root of e.roots) {
    for (const file of ['.codebase-semantic-index/index.json', '.codebase-semantic-index/vectors-generation.bin', '.intellisearch/vectors.bin', '.git/objects/aa/bb', '.git/logs/HEAD']) {
      e.watcher.onDidCreate.fire(e.vscode.Uri.joinPath(root, file));
      e.watcher.onDidChange.fire(e.vscode.Uri.joinPath(root, file));
      e.watcher.onDidDelete.fire(e.vscode.Uri.joinPath(root, file));
    }
  }
  assert.deepEqual(e.scheduled, []);
});

test('exclusion configuration changes schedule every root and unrelated settings do not', () => {
  const e = setup();
  for (const key of ['files.exclude', 'search.exclude', 'codebaseSemanticIndex']) {
    e.lifecycle.onDidChangeConfiguration.fire({ affectsConfiguration: candidate => candidate === key });
  }
  assert.deepEqual(e.scheduled, [...e.roots, ...e.roots, ...e.roots].map(uri => uri.toString()));
  e.lifecycle.onDidChangeConfiguration.fire({ affectsConfiguration: candidate => candidate === 'editor.fontSize' });
  assert.equal(e.scheduled.length, 6);
});

test('optional Git state notifications reconcile roots without reading history', async () => {
  const existing = { state: { onDidChange: event() } };
  const added = { state: { onDidChange: event() } };
  const opened = event();
  const git = { activate: async () => ({ getAPI: version => {
    assert.equal(version, 1);
    return { repositories: [existing], onDidOpenRepository: opened };
  } }) };
  const e = setup(git);
  await Promise.resolve();
  assert.equal(existing.state.onDidChange.size(), 1);
  existing.state.onDidChange.fire();
  assert.deepEqual(e.scheduled, e.roots.map(uri => uri.toString()));
  opened.fire(added);
  assert.equal(added.state.onDidChange.size(), 1);
  added.state.onDidChange.fire();
  assert.equal(e.scheduled.length, 6);
  for (const subscription of e.context.subscriptions) subscription.dispose();
  assert.equal(existing.state.onDidChange.size(), 0);
  assert.equal(added.state.onDidChange.size(), 0);
});
