const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTs } = require('./helpers.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const DIM = 1024;

function encoded(count = 1, position = 0) {
  const vectors = new Float32Array(count * DIM);
  for (let i = 0; i < count; i++) vectors[i * DIM + position] = 1;
  return Buffer.from(vectors.buffer).toString('base64');
}

function host() {
  let receive;
  let dispose;
  const messages = [];
  const uri = value => ({ toString: () => value });
  const api = loadTs('src/embeddingWorker.ts', {
    './webview/worker.html': { default: fs.readFileSync(path.join(__dirname, '../src/webview/worker.html'), 'utf8') },
    vscode: {
      Uri: { joinPath: (base, ...parts) => uri([base.toString(), ...parts].join('/')) },
      commands: { executeCommand: async () => {} },
      CancellationError: class CancellationError extends Error { constructor() { super('Cancelled'); } },
    },
    './utils': {
      base64ToFloat32: value => {
        const bytes = Buffer.from(value, 'base64');
        return new Float32Array(Uint8Array.from(bytes).buffer);
      },
    },
  });
  const provider = new api.CodebaseSemanticIndexWorkerProvider({ extensionUri: uri('file:///extension'), subscriptions: [] });
  const view = {
    webview: {
      cspSource: 'test-csp',
      asWebviewUri: value => value,
      onDidReceiveMessage: callback => { receive = callback; return { dispose() {} }; },
      postMessage: async message => { messages.push(message); return true; },
    },
    onDidDispose: callback => { dispose = callback; return { dispose() {} }; },
  };
  provider.resolveWebviewView(view);
  return { api, messages, view, send: message => receive(message), dispose: () => dispose() };
}

test('concurrent batches retain independent request IDs and vector results', async () => {
  const h = host();
  h.send({ type: 'modelReady' });
  const first = h.api.embedBatch([{ text: 'one', file: 'a.ts' }], () => {});
  const second = h.api.embedBatch([{ text: 'two', file: 'b.ts' }], () => {});
  await tick();
  const requests = h.messages.filter(message => message.type === 'startEmbedding');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  h.send({ type: 'embeddingsDone', requestId: requests[1].requestId, vectors: encoded(1, 1) });
  h.send({ type: 'embeddingsDone', requestId: requests[0].requestId, vectors: encoded(1, 0) });
  assert.equal((await first)[0], 1);
  assert.equal((await second)[1], 1);
});

test('model load failure rejects queued requests immediately and remains explicit', async () => {
  const h = host();
  const query = assert.rejects(h.api.embedQuery('find code'), /failed to load: offline/);
  const batch = assert.rejects(h.api.embedBatch([{ text: 'code', file: 'a.ts' }], () => {}), /failed to load: offline/);
  h.send({ type: 'modelError', message: 'offline' });
  await Promise.all([query, batch]);
  await assert.rejects(h.api.embedQuery('retry'), /failed to load: offline/);
});

test('disposing the worker rejects every in-flight request', async () => {
  const h = host();
  h.send({ type: 'modelReady' });
  const query = assert.rejects(h.api.embedQuery('code'), /worker was closed/);
  const batch = assert.rejects(h.api.embedBatch([{ text: 'code', file: 'a.ts' }], () => {}), /worker was closed/);
  await tick();
  h.dispose();
  await Promise.all([query, batch]);
});

test('cancellation settles a request and ignores its late reply', async () => {
  const h = host();
  h.send({ type: 'modelReady' });
  let cancel;
  let disposed = false;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: callback => { cancel = callback; return { dispose() { disposed = true; } }; },
  };
  const query = assert.rejects(h.api.embedQuery('cancel me', token), /Cancelled/);
  await tick();
  const request = h.messages.find(message => message.type === 'embedQuery');
  cancel();
  await query;
  assert.equal(disposed, true);
  assert(h.messages.some(message => message.type === 'cancelEmbedding' && message.requestId === request.requestId));
  h.send({ type: 'queryEmbedding', requestId: request.requestId, vector: encoded() });
  const next = h.api.embedQuery('next');
  await tick();
  const nextRequest = h.messages.filter(message => message.type === 'embedQuery').at(-1);
  h.send({ type: 'queryEmbedding', requestId: nextRequest.requestId, vector: encoded() });
  assert.equal((await next)[0], 1);
});

test('invalid dimensions, zero vectors and non-finite vectors reject instead of succeeding', async () => {
  const h = host();
  h.send({ type: 'modelReady' });
  const zero = new Float32Array(DIM);
  const nonFinite = new Float32Array(DIM); nonFinite[0] = NaN;
  for (const [data, pattern] of [
    [new Float32Array(2), /dimension mismatch/],
    [zero, /zero or is not normalized/],
    [nonFinite, /non-finite/],
  ]) {
    const query = assert.rejects(h.api.embedQuery('bad vector'), pattern);
    await tick();
    const request = h.messages.filter(message => message.type === 'embedQuery').at(-1);
    h.send({ type: 'queryEmbedding', requestId: request.requestId, vector: Buffer.from(data.buffer).toString('base64') });
    await query;
  }
});

test('unresolved worker creation is bounded by the query watchdog', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = host();
  const query = assert.rejects(h.api.embedQuery('waiting for model'), /timed out after 60 seconds/);
  t.mock.timers.tick(60_000);
  await query;
});

test('batch watchdog measures inactivity and resets on progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = host();
  h.send({ type: 'modelReady' });
  const progress = [];
  const batch = h.api.embedBatch([{ text: 'a', file: 'a.ts' }, { text: 'b', file: 'b.ts' }], (...args) => progress.push(args));
  await tick();
  const request = h.messages.find(message => message.type === 'startEmbedding');
  t.mock.timers.tick(100_000);
  h.send({ type: 'embedProgress', requestId: request.requestId, done: 1, total: 2, file: 'a.ts' });
  t.mock.timers.tick(100_000);
  h.send({ type: 'embeddingsDone', requestId: request.requestId, vectors: encoded(2) });
  assert.equal((await batch).length, DIM * 2);
  assert.deepEqual(progress, [[1, 2, 'a.ts']]);
});

test('worker HTML receives the pinned model configuration', () => {
  const h = host();
  assert(h.view.webview.html.includes('c25a394dd583836952667c12f008335071b3f43d'));
  assert(!h.view.webview.html.includes('__EMBEDDING_CONFIG__'));
  assert(h.view.webview.html.includes('queryInstruction'));
});

function webWorker(extractor, navigator = {}) {
  const html = fs.readFileSync(path.join(__dirname, '../src/webview/worker.html'), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace('__EMBEDDING_CONFIG__', JSON.stringify({ model: 'test-model', revision: 'test-revision', dimension: DIM, queryInstruction: 'Instruct: code\nQuery:' }))
    .replace("await import('__TRANSFORMERS_URI__')", 'await loadTransformers()');
  const messages = [];
  const pipelineCalls = [];
  const env = { backends: { onnx: { wasm: {} } } };
  let receive;
  const context = {
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
    document: { getElementById: () => ({ style: {}, textContent: '', className: '' }) },
    navigator,
    window: { addEventListener: (name, callback) => { receive = callback; } },
    setInterval() {},
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    loadTransformers: async () => ({ pipeline: async (...args) => { pipelineCalls.push(args); return extractor; }, env }),
  };
  vm.runInNewContext(script, context);
  return { messages, env, pipelineCalls, send: message => receive({ data: message }) };
}

test('worker uses pinned q8 WASM even when WebGPU is present', async () => {
  const worker = webWorker(async () => {}, { gpu: { requestAdapter() { throw new Error('GPU must not be initialized'); } } });
  await tick();
  assert.equal(worker.pipelineCalls.length, 1);
  const [task, model, options] = worker.pipelineCalls[0];
  assert.equal(task, 'feature-extraction');
  assert.equal(model, 'test-model');
  assert.equal(options.dtype, 'q8');
  assert.equal(options.device, 'wasm');
  assert.equal(options.revision, 'test-revision');
  assert.equal(worker.env.backends.onnx.wasm.numThreads, 1);
  assert(worker.messages.some(message => message.type === 'modelReady'));
});

test('every worker runtime asset is packaged from the resolved installed dependency', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/webview/worker.html'), 'utf8');
  const config = require('../webpack.config.js')[0];
  const patterns = config.plugins.find(plugin => plugin.constructor.name === 'CopyPlugin').patterns;
  const assets = [...html.matchAll(/__WASM_DIR_URI__([^'"\s]+)/g)].map(match => match[1]);
  assert(assets.length > 0);
  for (const asset of ['transformers.min.js', ...assets]) {
    const packaged = patterns.find(pattern => pattern.to === asset);
    assert(packaged, `${asset} must be copied into dist/web`);
    assert(fs.existsSync(packaged.from), `installed runtime asset ${asset} must exist`);
  }
});

test('a failed chunk aborts the worker batch with file context and never returns partial zero vectors', async () => {
  let call = 0;
  const worker = webWorker(async () => {
    if (++call === 2) throw new Error('inference failed');
    const data = new Float32Array(DIM); data[0] = 1;
    return { data };
  });
  await tick();
  await worker.send({ type: 'startEmbedding', requestId: 'batch', chunks: [{ text: 'a', file: 'a.ts' }, { text: 'b', file: 'b.ts' }] });
  const failure = worker.messages.find(message => message.type === 'embeddingError');
  assert.match(failure.message, /b\.ts \(chunk 2\/2\): inference failed/);
  assert.equal(failure.requestId, 'batch');
  assert(!worker.messages.some(message => message.type === 'embeddingsDone'));
});

test('worker serializes extractor calls and can interleave queries between batch chunks', async () => {
  let running = 0;
  let maximum = 0;
  const calls = [];
  const worker = webWorker(async text => {
    calls.push(text);
    maximum = Math.max(maximum, ++running);
    await tick();
    running--;
    const data = new Float32Array(DIM); data[0] = 1;
    return { data };
  });
  await tick();
  const batch = worker.send({ type: 'startEmbedding', requestId: 'batch', chunks: [{ text: 'a', file: 'a.ts' }, { text: 'b', file: 'b.ts' }] });
  const query = worker.send({ type: 'embedQuery', requestId: 'query', query: 'find' });
  await Promise.all([batch, query]);
  assert.equal(maximum, 1);
  assert.deepEqual(calls, ['a', 'Instruct: code\nQuery:find', 'b']);
  assert(worker.messages.some(message => message.type === 'queryEmbedding' && message.requestId === 'query'));
  assert(worker.messages.some(message => message.type === 'embeddingsDone' && message.requestId === 'batch'));
});
