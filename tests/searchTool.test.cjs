const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers.cjs');
const { mockVscode } = require('./mockVscode.cjs');

function ranked(file = 'src/current.ts', text = 'export const currentFeature = true;') {
	return { score: 0.03, candidate: { file, text, rootUri: 'file:///workspace', rootName: 'app',
		range: { start: 0, end: 0, startCharacter: 0, endCharacter: text.length }, contentHash: text } };
}

function setup(results = [ranked()]) {
	const env = mockVscode();
	env.addRoot(env.vscode.Uri.parse('file:///workspace'), 'app');
	const calls = [];
	let verifies = 0;
	const service = {
		async search(...args) { calls.push(args); return { results: [...results], statuses: [] }; },
		async verify(results) { verifies++; return results; },
	};
	const { CodebaseSemanticIndexTool } = loadTs('src/searchTool.ts', { vscode: env.vscode, './workspaceIndex': { workspaceIndex: service } });
	const source = new env.vscode.CancellationTokenSource();
	const tool = new CodebaseSemanticIndexTool();
	async function invoke(input = { query: 'currentFeature' }, tokenizationOptions, token = source.token) {
		return tool.invoke({ input, tokenizationOptions }, token);
	}
	return { ...env, calls, service, source, invoke, verifyCount: () => verifies };
}

const output = result => result.content.map(part => part.value).join('');

test('tool preserves current source, defaults to five, and reports precise ranges without percent matches', async () => {
	const e = setup();
	const text = output(await e.invoke());
	assert.deepEqual(e.calls[0].slice(0, 3), ['currentFeature', '', 5]);
	assert.match(text, /file:\/\/\/workspace/);
	assert.match(text, /L1:1/);
	assert.match(text, /export const currentFeature = true;/);
	assert.doesNotMatch(text, /% match/);
	assert.ok(e.verifyCount() > 0);
});

test('tool bounds result count and normalizes a relative path filter', async () => {
	const e = setup();
	await e.invoke({ query: 'currentFeature', maxResults: 999, pathPrefix: './src\\services/' });
	assert.deepEqual(e.calls[0].slice(0, 3), ['currentFeature', 'src/services', 20]);
	await e.invoke({ query: 'currentFeature', maxResults: -3 });
	assert.equal(e.calls[1][2], 1);
});

test('invalid queries and escaping paths are rejected before invoking workspace search', async () => {
	for (const input of [{ query: '  ' }, { query: 3 }, { query: 'value', pathPrefix: '../outside' }, { query: 'value', pathPrefix: 'C:\\outside' }]) {
		const e = setup();
		assert.match(output(await e.invoke(input)), /query must|pathPrefix/);
		assert.equal(e.calls.length, 0);
	}
});

test('zero and tiny token budgets return no oversized text', async () => {
	for (const tokenBudget of [0, 1, 5]) {
		const e = setup();
		const text = output(await e.invoke(undefined, { tokenBudget, countTokens: async text => text.length }));
		assert.ok(text.length <= tokenBudget);
	}
});

test('token budgeting removes whole results without truncating source excerpts', async () => {
	const first = ranked('src/first.ts', 'export const FIRST_COMPLETE_SOURCE = true;');
	const second = ranked('src/second.ts', 'export const SECOND_COMPLETE_SOURCE = true;');
	const alone = setup([first]);
	const firstText = output(await alone.invoke(undefined, { tokenBudget: 1500, countTokens: async text => text.length }));
	const e = setup([first, second]);
	const text = output(await e.invoke(undefined, { tokenBudget: firstText.length, countTokens: async text => text.length }));
	assert.ok(text.length <= firstText.length);
	assert.match(text, /export const FIRST_COMPLETE_SOURCE = true;/);
	assert.doesNotMatch(text, /SECOND_COMPLETE_SOURCE/);
});

test('tool caps even a generous host budget at its local output ceiling', async () => {
	const e = setup(Array.from({ length: 20 }, (_, i) => ranked(`src/${i}.ts`, 'x'.repeat(400))));
	const text = output(await e.invoke(undefined, { tokenBudget: 50000, countTokens: async text => text.length }));
	assert.ok(text.length <= 1500);
});

test('validation and no-workspace messages also honor a zero output budget', async () => {
	const e = setup();
	const budget = { tokenBudget: 0, countTokens: async text => text.length };
	assert.equal(output(await e.invoke({ query: ' ' }, budget)), '');
	e.vscode.workspace.workspaceFolders = [];
	assert.equal(output(await e.invoke(undefined, budget)), '');
});

test('cancelled invocation does not begin workspace search', async () => {
	const e = setup();
	e.source.cancel();
	await assert.rejects(e.invoke(), /Canceled/);
	assert.equal(e.calls.length, 0);
});

test('cancellation while the tokenizer awaits rejects instead of returning source', async () => {
	const e = setup();
	await assert.rejects(e.invoke(undefined, {
		tokenBudget: 1500,
		async countTokens(text) { e.source.cancel(); return text.length; },
	}), /Canceled/);
});

test('edits during token counting suppress stale source before returning evidence', async () => {
	const e = setup([ranked('src/old.ts', 'export const OBSOLETE_BRANCH_SOURCE = true;')]);
	let edited = false;
	e.service.verify = async results => edited ? [] : results;
	const text = output(await e.invoke(undefined, {
		tokenBudget: 1500,
		async countTokens(text) { edited = true; return text.length; },
	}));
	assert.doesNotMatch(text, /OBSOLETE_BRANCH_SOURCE/);
	assert.match(text, /No verified current-file matches/);
});

test('empty lexical fallback exposes status without claiming semantic success', async () => {
	const e = setup([]);
	e.service.search = async () => ({ results: [], statuses: ['Model unavailable; current-file lexical search is active.'] });
	const text = output(await e.invoke());
	assert.match(text, /Model unavailable/);
	assert.match(text, /No verified current-file matches/);
});
