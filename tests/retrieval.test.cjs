const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers.cjs');
const {
	rankCandidates, normalizeMaxResults, normalizePathPrefix, matchesPathPrefix, candidateExcerpt,
} = loadTs('src/retrieval.ts');

function candidate(file, text, options = {}) {
	return {
		file, text, range: { start: 0, end: 2 }, rootUri: 'file:///workspace', rootName: 'workspace',
		contentHash: text, ...options,
	};
}

test('exact identifiers beat broad component matches and tokenize camel/snake names', () => {
	const results = rankCandidates([
		candidate('src/other.ts', 'function other() { return cache; }', { symbolName: 'other' }),
		candidate('src/memory.ts', 'function connectMemoryCache() { return true; }', { symbolName: 'connectMemoryCache' }),
	], 'connectMemoryCache');
	assert.equal(results[0].candidate.symbolName, 'connectMemoryCache');
	assert.equal(rankCandidates([candidate('src/a.ts', 'const retry_pending_jobs = true;')], 'retry pending jobs').length, 1);
	assert.equal(rankCandidates([candidate('src/a.ts', 'const XMLParser = true;')], 'parser')[0].candidate.file, 'src/a.ts');
});

test('lexical fallback never returns nonmatching chunks', () => {
	const results = rankCandidates([
		candidate('src/jobs.ts', 'const retryQueue = true;'),
		candidate('src/pets.ts', 'const kitten = true;'),
	], 'retry queue');
	assert.deepEqual(results.map(item => item.candidate.file), ['src/jobs.ts']);
	assert.deepEqual(rankCandidates([candidate('a.ts', 'const kitten = true;')], 'unimplementedMethod'), []);
	assert.deepEqual(rankCandidates([candidate('a.ts', 'anything')], '  '), []);
});

test('dense retrieval can find a concept without lexical overlap', () => {
	const results = rankCandidates([
		candidate('src/a.ts', 'const kittens = true;', { vector: new Float32Array([0, 1]) }),
		candidate('src/b.ts', 'const dogs = true;', { vector: new Float32Array([3, 0]) }),
	], 'semantic concept', new Float32Array([1, 0]));
	assert.equal(results[0].candidate.file, 'src/b.ts');
	assert.equal(results[0].similarity, 1);
});

test('RRF uses both channels and ignores invalid embeddings', () => {
	const results = rankCandidates([
		candidate('src/meaning.ts', 'other behavior', { vector: new Float32Array([1, 0]) }),
		candidate('src/retry.ts', 'retry failed operations', { vector: new Float32Array([0.9, 0.1]) }),
		candidate('src/invalid.ts', 'not relevant', { vector: new Float32Array([NaN, 0]) }),
		candidate('src/zero.ts', 'not relevant', { vector: new Float32Array([0, 0]) }),
		candidate('src/wrong.ts', 'not relevant', { vector: new Float32Array([1]) }),
	], 'retry', new Float32Array([1, 0]));
	assert.equal(results[0].candidate.file, 'src/retry.ts');
	assert.deepEqual(results.map(item => item.candidate.file).sort(), ['src/meaning.ts', 'src/retry.ts']);
});

test('a current lexical-only exact identifier outranks weaker dual-channel matches', () => {
	const exact = candidate('src/current.ts', 'export function retryPendingJobs() { return true; }');
	const weaker = candidate('src/retry.ts', 'const retry = pending + jobs;', { vector: new Float32Array([1, 0]) });
	assert.equal(rankCandidates([weaker, exact], 'retryPendingJobs', new Float32Array([1, 0]))[0].candidate, exact);
});

test('a current lexical-only exact path outranks weaker dual-channel matches', () => {
	const exact = candidate('src/jobs/retry.ts', 'export const current = true;');
	const weaker = candidate('src/jobs/retry-old.ts', 'export const retry = true;', { vector: new Float32Array([1, 0]) });
	assert.equal(rankCandidates([weaker, exact], 'src/jobs/retry.ts', new Float32Array([1, 0]))[0].candidate, exact);
});

test('equally exact candidates retain their dense ranking benefit', () => {
	const current = candidate('src/current.ts', 'export function retryPendingJobs() {}');
	const indexed = candidate('src/indexed.ts', 'export function retryPendingJobs() {}', { vector: new Float32Array([1, 0]) });
	const results = rankCandidates([current, indexed], 'retryPendingJobs', new Float32Array([1, 0]));
	assert.equal(results[0].candidate, indexed);
	assert.ok(results[0].score > results[1].score);
});

test('deduplication suppresses overlapping chunks within a file, but preserves roots and adjacent ranges', () => {
	const a = candidate('src/a.ts', 'retry', { range: { start: 0, end: 4 } });
	const overlapping = candidate('src/a.ts', 'retry', { range: { start: 3, end: 8 } });
	const adjacent = candidate('src/a.ts', 'retry', { range: { start: 5, end: 6 } });
	const otherRoot = candidate('src/a.ts', 'retry', { rootUri: 'vscode-remote://ssh-remote+host/workspace' });
	assert.deepEqual(rankCandidates([a, overlapping, adjacent, otherRoot], 'retry').map(item => item.candidate), [a, adjacent, otherRoot]);
	const columnA = candidate('line.ts', 'retry', { range: { start: 0, startCharacter: 0, end: 0, endCharacter: 5 } });
	const columnB = candidate('line.ts', 'retry', { range: { start: 0, startCharacter: 5, end: 0, endCharacter: 10 } });
	assert.equal(rankCandidates([columnA, columnB], 'retry').length, 2);
});

test('maxResults is bounded and defaults to five', () => {
	assert.equal(normalizeMaxResults(undefined), 5);
	assert.equal(normalizeMaxResults('20'), 5);
	assert.equal(normalizeMaxResults(NaN), 5);
	assert.equal(normalizeMaxResults(Infinity), 5);
	assert.equal(normalizeMaxResults(-100), 1);
	assert.equal(normalizeMaxResults(8.9), 8);
	assert.equal(normalizeMaxResults(100), 20);
	const candidates = Array.from({ length: 30 }, (_, i) => candidate(`${i}.ts`, 'retry'));
	assert.equal(rankCandidates(candidates, 'retry').length, 5);
	assert.equal(rankCandidates(candidates, 'retry', undefined, 300).length, 20);
});

test('path prefixes normalize only relative paths and respect segment boundaries', () => {
	assert.equal(normalizePathPrefix(undefined), '');
	assert.equal(normalizePathPrefix('./src\\components//'), 'src/components');
	assert.equal(normalizePathPrefix('.'), '');
	for (const prefix of ['/src', '\\server\\src', 'C:\\src', 'https://host/src', '../src', 'src/../secret', 'src\0x', null]) {
		assert.throws(() => normalizePathPrefix(prefix), /pathPrefix/);
	}
	assert.equal(matchesPathPrefix('src/a.ts', 'src'), true);
	assert.equal(matchesPathPrefix('src/a.ts', 'src/a.ts'), true);
	assert.equal(matchesPathPrefix('src2/a.ts', 'src'), false);
	assert.equal(matchesPathPrefix('src/a.ts.old', 'src/a.ts'), false);
	assert.equal(matchesPathPrefix('anywhere', ''), true);
});

test('source excerpts preserve source and compute exact line and column positions', () => {
	const source = candidate('a.ts', 'abc\r\ndef\r\nghi', { range: { start: 10, startCharacter: 4, end: 12, endCharacter: 3 } });
	assert.deepEqual(candidateExcerpt(source, 7), {
		text: 'abc\r\nde', range: { start: 10, startCharacter: 4, end: 11, endCharacter: 2 },
	});
	assert.deepEqual(candidateExcerpt(source, 4), {
		text: 'abc', range: { start: 10, startCharacter: 4, end: 10, endCharacter: 7 },
	});
	assert.equal(candidateExcerpt(candidate('a.ts', 'a😀b'), 2).text, 'a');
	assert.equal(candidateExcerpt(candidate('a.ts', 'a😀b'), 3).text, 'a😀');
	assert.deepEqual(candidateExcerpt(source, 0).range, { start: 10, startCharacter: 4, end: 10, endCharacter: 4 });
});
