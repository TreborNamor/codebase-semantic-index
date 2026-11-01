const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers.cjs');
const { mockVscode } = require('./mockVscode.cjs');

function setup() {
  const env = mockVscode();
  const { vscode } = env;
  const config = loadTs('src/embeddingConfig.ts');
  const batches = [];
  let intercept;
  const embeddings = {
    async waitForEmbeddingReady() {},
    async embedBatch(chunks) {
      batches.push(chunks);
      if (intercept) await intercept(chunks);
      const vectors = new Float32Array(chunks.length * config.VECTOR_DIM);
      for (let i = 0; i < chunks.length; i++) vectors[i * config.VECTOR_DIM] = 1;
      return vectors;
    },
    async embedQuery() { const vec = new Float32Array(config.VECTOR_DIM); vec[0] = 1; return vec; },
  };
  const { WorkspaceIndexService } = loadTs('src/workspaceIndex.ts', { vscode, './embeddingWorker': embeddings });
  const service = new WorkspaceIndexService();
  // Timers are exercised by activation/queue tests; explicit calls control reconciliation here.
  service.schedule = () => {};
  const root = vscode.Uri.parse('file:///workspace');
  env.addRoot(root, 'app');
  return { ...env, root, service, batches, embeddings, intercept: fn => { intercept = fn; } };
}

test('same filename after checkout never returns old branch contents', async () => {
  const e = setup();
  e.addFile(e.root, 'src/branch.ts', 'export const branchFeature = "old coworker implementation";');
  await e.service.rebuild(e.root);
  e.addFile(e.root, 'src/branch.ts', 'export const localFeature = "current checkout implementation";');
  assert.equal((await e.service.search('coworker')).results.length, 0);
  const found = (await e.service.search('localFeature')).results;
  assert.equal(found.length, 1);
  assert.match(found[0].candidate.text, /current checkout/);
  assert.equal(found[0].candidate.vector, undefined);
  await e.service.rebuild(e.root);
  assert.ok((await e.service.search('localFeature')).results[0].candidate.vector);
  e.service.dispose();
});

test('unsaved buffer overrides disk and disappears on revert without being persisted', async () => {
  const e = setup();
  const uri = e.addFile(e.root, 'src/live.ts', 'export const diskValue = "saved";');
  await e.service.rebuild(e.root);
  const doc = e.document(uri, 'export const unsavedValue = "dirty buffer";');
  e.vscode.workspace.textDocuments.push(doc);
  const found = await e.service.search('unsavedValue');
  assert.match(found.results[0].candidate.text, /dirty buffer/);
  await e.service.rebuild(e.root);
  assert.equal([...e.files.entries()].filter(([key]) => key.endsWith('.json')).some(([, bytes]) => new TextDecoder().decode(bytes).includes('unsavedValue')), false);
  doc.setText('export const diskValue = "saved";', false);
  e.service.onDocumentChanged(doc);
  assert.match((await e.service.search('diskValue')).results[0].candidate.text, /diskValue/);
  e.service.dispose();
});

test('deleted and newly ignored files are suppressed before reconciliation', async () => {
  const e = setup();
  const gone = e.addFile(e.root, 'src/gone.ts', 'export const deletedFeature = true;');
  e.addFile(e.root, 'src/hidden.ts', 'export const ignoredFeature = true;');
  await e.service.rebuild(e.root);
  e.files.delete(gone.toString());
  e.addFile(e.root, '.gitignore', 'src/hidden.ts\n');
  assert.equal((await e.service.search('Feature')).results.length, 0);
  await e.service.rebuild(e.root);
  assert.equal((await e.service.getStatus(e.root)).chunkCount, 0);
  e.service.dispose();
});

test('changes made while embedding runs are drained even without watcher delivery', async () => {
  const e = setup();
  e.addFile(e.root, 'src/busy.ts', 'export const beforeBuild = true;');
  let changed = false;
  e.intercept(async () => {
    if (!changed) { changed = true; e.addFile(e.root, 'src/busy.ts', 'export const duringBuild = true;'); }
  });
  await e.service.rebuild(e.root);
  const found = await e.service.search('duringBuild');
  assert.match(found.results[0].candidate.text, /duringBuild/);
  assert.ok(found.results[0].candidate.vector, 'second pass committed the changed version');
  assert.equal(e.batches.length, 2);
  e.service.dispose();
});

test('same path in distinct roots and remote authorities stays separate', async () => {
  const e = setup();
  const other = e.vscode.Uri.parse('vscode-remote://other-host/workspace');
  e.addRoot(other, 'remote');
  e.addFile(e.root, 'src/shared.ts', 'export const sharedFeature = "local";');
  e.addFile(other, 'src/shared.ts', 'export const sharedFeature = "remote";');
  await e.service.rebuild(e.root);
  await e.service.rebuild(other);
  const found = (await e.service.search('sharedFeature')).results;
  assert.equal(found.length, 2);
  assert.equal(new Set(found.map(result => result.candidate.rootUri)).size, 2);
  e.vscode.workspace.workspaceFolders = e.vscode.workspace.workspaceFolders.filter(folder => folder.uri !== e.root);
  assert.equal((await e.service.verify(found)).length, 1);
  e.service.dispose();
});

test('failed embedding is explicit and current lexical search remains available', async () => {
  const e = setup();
  e.addFile(e.root, 'src/error.ts', 'export const recoverableFeature = true;');
  e.intercept(() => { throw new Error('model failed'); });
  await assert.rejects(e.service.rebuild(e.root), /model failed/);
  const found = await e.service.search('recoverableFeature');
  assert.match(found.statuses.join(' '), /model failed/);
  assert.equal(found.results.length, 1);
  assert.equal([...e.files.keys()].some(key => key.endsWith('/index.json')), false);
  e.intercept(undefined);
  await e.service.rebuild(e.root);
  assert.ok((await e.service.search('recoverableFeature')).results[0].candidate.vector);
  e.service.dispose();
});

test('unchanged content reuses vectors and scope cannot escape a root', async () => {
  const e = setup();
  e.addFile(e.root, 'src/source.ts', 'export const scopedFeature = true;');
  e.addFile(e.root, 'test/source.ts', 'export const scopedFeature = false;');
  await e.service.rebuild(e.root);
  const calls = e.batches.length;
  await e.service.rebuild(e.root);
  assert.equal(e.batches.length, calls);
  assert.equal((await e.service.search('scopedFeature', 'src')).results.length, 1);
  await assert.rejects(e.service.search('feature', '../outside'), /outside/);
  e.service.dispose();
});

test('offline edits and deletions are reconciled after a fresh service loads', async () => {
  const e = setup();
  const removed = e.addFile(e.root, 'src/deleted.ts', 'export const previous = true;');
  e.addFile(e.root, 'src/retained.ts', 'export const beforeRestart = true;');
  await e.service.rebuild(e.root);
  e.service.dispose();
  e.files.delete(removed.toString());
  e.addFile(e.root, 'src/retained.ts', 'export const afterRestart = true;');
  const { WorkspaceIndexService } = loadTs('src/workspaceIndex.ts', { vscode: e.vscode, './embeddingWorker': e.embeddings });
  const next = new WorkspaceIndexService(); next.schedule = () => {};
  await next.rebuild(e.root);
  assert.equal((await next.getStatus(e.root)).fileCount, 1);
  assert.match((await next.search('afterRestart')).results[0].candidate.text, /afterRestart/);
  next.dispose();
});

test('removed roots cannot start delayed background embedding work', async () => {
  const e = setup();
  e.addFile(e.root, 'src/removed.ts', 'export const outsideActiveWorkspace = true;');
  e.vscode.workspace.workspaceFolders = [];
  await e.service.rebuild(e.root);
  assert.equal(e.batches.length, 0);
  e.service.dispose();
});

test('files reached through linked descendant directories are not retrieved', async () => {
  const e = setup();
  e.addFile(e.root, 'linked/foreign.ts', 'export const otherCheckout = true;');
  const stat = e.vscode.workspace.fs.stat;
  e.vscode.workspace.fs.stat = async uri => uri.path === '/workspace/linked' ? { type: 66, size: 0 } : stat(uri);
  await e.service.rebuild(e.root);
  assert.equal((await e.service.search('otherCheckout')).results.length, 0);
  assert.equal(e.batches.length, 0);
  e.service.dispose();
});

test('dirty edits during hashing retry the live version instead of pairing old text with a new version', async () => {
  const e = setup();
  const uri = e.addFile(e.root, 'src/race.ts', 'export const savedState = true;');
  const doc = e.document(uri, 'export const oldBuffer = true;');
  e.vscode.workspace.textDocuments.push(doc);
  const getText = doc.getText;
  let once = false;
  doc.getText = range => {
    const text = getText(range);
    if (!once) { once = true; queueMicrotask(() => doc.setText('export const newestBuffer = true;')); }
    return text;
  };
  const found = await e.service.search('newestBuffer');
  assert.equal(found.results.length, 1);
  assert.match(found.results[0].candidate.text, /newestBuffer/);
  e.service.dispose();
});
