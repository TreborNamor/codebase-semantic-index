const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { loadTs } = require('./helpers.cjs');
const { mockVscode } = require('./mockVscode.cjs');

const enc = new TextEncoder();
const dec = new TextDecoder();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function setup() {
	const env = mockVscode();
	const { vscode } = env;
	const store = loadTs('src/indexStore.ts', { vscode });
	const config = loadTs('src/embeddingConfig.ts');
	const { CHUNKER_VERSION } = loadTs('src/chunker.ts', { vscode });
	const { workspaceKey } = loadTs('src/utils.ts', { vscode });
	const root = vscode.Uri.parse('file:///workspace');
	const key = filename => vscode.Uri.joinPath(root, '.codebase-semantic-index', filename).toString();
	function fixture(generation = '0001-first') {
		const vectors = new Float32Array(config.VECTOR_DIM);
		vectors[0] = 1;
		return {
			data: {
				meta: {
					version: store.INDEX_VERSION, model: config.MODEL_NAME, modelRevision: config.MODEL_REVISION,
					pipelineId: config.PIPELINE_ID, chunkerVersion: CHUNKER_VERSION, rootUri: workspaceKey(root),
					generation, created: 1, chunkCount: 1, vectorDim: config.VECTOR_DIM,
				},
				files: { 'src/current.ts': { hash: 'a'.repeat(64) } },
				chunks: [{ file: 'src/current.ts', range: { start: 0, end: 0, startCharacter: 0, endCharacter: 10 },
					preview: 'const test', vectorOffset: 0, contentHash: 'b'.repeat(64), embeddingHash: 'c'.repeat(64) }],
			},
			vectors,
		};
	}
	return { ...env, store, config, root, key, fixture };
}

test('valid index round-trips only the supplied vector view and no index returns null', async () => {
	const e = setup();
	assert.equal(await e.store.loadIndex(e.root), null);
	const { data, vectors } = e.fixture();
	const backing = new Float32Array(e.config.VECTOR_DIM + 2);
	backing[0] = 9; backing[1] = 1; backing[backing.length - 1] = 9;
	await e.store.saveIndex(e.root, data, backing.subarray(1, backing.length - 1));
	const loaded = await e.store.loadIndex(e.root);
	assert.deepEqual(loaded.data, data);
	assert.deepEqual(loaded.vectors, vectors);
	assert.equal(await e.store.indexExists(e.root), true);
});

test('foreign root, model, pipeline, dimension, chunker, and schema metadata are rejected', () => {
	const e = setup();
	for (const [field, value] of [
		['rootUri', 'file:///coworker'], ['model', 'other-model'], ['modelRevision', 'other-revision'],
		['pipelineId', 'other-pipeline'], ['vectorDim', 2], ['chunkerVersion', -1], ['version', -1],
		['generation', '../outside'], ['created', NaN],
	]) {
		const index = e.fixture(); index.data.meta[field] = value;
		assert.throws(() => e.store.validateIndex(e.root, index), e.store.IndexCompatibilityError, field);
	}
});

test('corrupt chunk metadata, paths, manifests, offsets, and invalid vectors are rejected', () => {
	const e = setup();
	const mutations = [
		index => { index.data.meta.chunkCount = 3; },
		index => { index.vectors = new Float32Array(3); },
		index => { index.data.files['src/current.ts'].hash = 'invalid'; },
		index => { index.data.chunks[0].file = '../outside.ts'; },
		index => { delete index.data.files['src/current.ts']; },
		index => { index.data.chunks[0].range.start = -1; },
		index => { index.data.chunks[0].range.endCharacter = -1; },
		index => { index.data.chunks[0].vectorOffset = 1; },
		index => { index.data.chunks[0].contentHash = 'invalid'; },
		index => { index.data.chunks[0].embeddingHash = 'invalid'; },
		index => { index.vectors[0] = NaN; },
		index => { index.vectors[0] = 0; },
		index => { index.vectors[0] = 2; },
	];
	for (const mutate of mutations) {
		const index = e.fixture(); mutate(index);
		assert.throws(() => e.store.validateIndex(e.root, index), e.store.IndexCompatibilityError);
	}
});

test('committed index copied to a different worktree or remote authority is rejected', async () => {
	const e = setup();
	const index = e.fixture();
	await e.store.saveIndex(e.root, index.data, index.vectors);
	for (const other of [e.vscode.Uri.parse('file:///other-worktree'), e.vscode.Uri.parse('vscode-remote://other-host/workspace')]) {
		const from = e.vscode.Uri.joinPath(e.root, '.codebase-semantic-index').toString();
		const to = e.vscode.Uri.joinPath(other, '.codebase-semantic-index').toString();
		for (const [key, bytes] of [...e.files]) {
			if (key.startsWith(from + '/')) e.files.set(to + key.slice(from.length), bytes.slice());
		}
		await assert.rejects(e.store.loadIndex(other), /another workspace|Rebuild required/);
	}
});

test('generation mismatch is rejected even with a valid metadata checksum', async () => {
	const e = setup();
	const index = e.fixture();
	await e.store.saveIndex(e.root, index.data, index.vectors);
	const pointer = JSON.parse(dec.decode(e.files.get(e.key('index.json'))));
	const metadata = JSON.parse(dec.decode(e.files.get(e.key(index.data.meta.generation + '.json'))));
	metadata.meta.generation = 'different-generation';
	const bytes = enc.encode(JSON.stringify(metadata));
	e.files.set(e.key(index.data.meta.generation + '.json'), bytes);
	if (pointer.dataHash) { pointer.dataHash = hash(bytes); e.files.set(e.key('index.json'), enc.encode(JSON.stringify(pointer))); }
	await assert.rejects(e.store.loadIndex(e.root), /generation mismatch|Rebuild required/);
});

test('normalized vector corruption is detected by the committed integrity hash', async () => {
	const e = setup();
	const index = e.fixture();
	await e.store.saveIndex(e.root, index.data, index.vectors);
	const pointer = JSON.parse(dec.decode(e.files.get(e.key('index.json'))));
	assert.match(pointer.vectorHash, /^[a-f0-9]{64}$/);
	assert.match(pointer.dataHash, /^[a-f0-9]{64}$/);
	const changed = new Float32Array(e.config.VECTOR_DIM); changed[1] = 1;
	e.files.set(e.key(index.data.meta.generation + '.bin'), new Uint8Array(changed.buffer));
	await assert.rejects(e.store.loadIndex(e.root), /integrity|checksum|hash|Rebuild required/i);
});

test('malformed, incomplete, and legacy indexes produce explicit rebuild errors', async () => {
	for (const content of ['{', JSON.stringify({ meta: { version: 1 }, chunks: [] }), JSON.stringify({ version: 2, generation: 'missing-files' })]) {
		const e = setup();
		e.files.set(e.key('index.json'), enc.encode(content));
		await assert.rejects(e.store.loadIndex(e.root), /Rebuild required/);
	}
	const e = setup();
	e.addFile(e.root, '.intellisearch/index.json', JSON.stringify({ meta: { version: 1 }, chunks: [] }));
	await assert.rejects(e.store.loadIndex(e.root), /Legacy|Rebuild required/);
});

test('failed generation write leaves the committed generation readable', async () => {
	const e = setup();
	const first = e.fixture();
	await e.store.saveIndex(e.root, first.data, first.vectors);
	const originalPointer = e.files.get(e.key('index.json')).slice();
	const second = e.fixture('0002-second');
	const writeFile = e.vscode.workspace.fs.writeFile;
	e.vscode.workspace.fs.writeFile = async (uri, bytes) => {
		if (uri.toString() === e.key('0002-second.bin')) throw new Error('disk unavailable');
		return writeFile(uri, bytes);
	};
	await assert.rejects(e.store.saveIndex(e.root, second.data, second.vectors), /disk unavailable/);
	assert.deepEqual(e.files.get(e.key('index.json')), originalPointer);
	assert.equal((await e.store.loadIndex(e.root)).data.meta.generation, '0001-first');
});

test('failed manifest publication leaves the previous committed generation readable', async () => {
	const e = setup();
	const first = e.fixture();
	await e.store.saveIndex(e.root, first.data, first.vectors);
	const originalPointer = e.files.get(e.key('index.json')).slice();
	const second = e.fixture('0002-second');
	e.vscode.workspace.fs.rename = async () => { throw new Error('manifest rename failed'); };
	await assert.rejects(e.store.saveIndex(e.root, second.data, second.vectors), /manifest rename failed/);
	assert.deepEqual(e.files.get(e.key('index.json')), originalPointer);
	assert.equal((await e.store.loadIndex(e.root)).data.meta.generation, '0001-first');
});
