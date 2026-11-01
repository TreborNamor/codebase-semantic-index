const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers.cjs');
const { mockVscode } = require('./mockVscode.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const { vscode } = mockVscode();
  const memory = new Map(), calls = [], commands = [];
  let selections = 0, picks = 0, reply = 'Improve the retry logic while preserving the API.';
  const model = {
    id: 'haiku-test', name: 'Claude Haiku (test)', maxInputTokens: 32000,
    countTokens: async message => Math.ceil(message.content.length / 4),
    async sendRequest(messages, options, token) {
      calls.push({ messages, options, token });
      return { text: (async function* () { yield reply; })() };
    },
  };
  const state = { get: key => memory.get(key), update: async (key, value) => memory.set(key, value) };
  vscode.LanguageModelChatMessage = { User: content => ({ role: 'user', content }) };
  vscode.lm = { selectChatModels: async selector => { assert.deepEqual(selector, { vendor: 'copilot' }); selections++; return [model]; } };
  vscode.window = { showQuickPick: async items => { picks++; return items[0]; } };
  vscode.commands.executeCommand = async (...args) => { commands.push(args); };
  const api = loadTs('src/promptRefiner.ts', { vscode });
  const refiner = new api.PromptRefiner(state);
  const cancellation = new vscode.CancellationTokenSource();
  return { vscode, api, refiner, state, memory, calls, commands, model, token: cancellation.token, cancellation,
    get selections() { return selections; }, get picks() { return picks; }, set reply(value) { reply = value; } };
}

test('refinement sends only rewriting instructions and the draft, with no tools or agent submission', async () => {
  const e = setup();
  assert.equal(e.selections, 0, 'constructing the feature must not contact a model');
  const draft = 'please fix retries in src/index.ts, keep maxResults=5 and #codebaseSemanticIndex';
  const result = await e.refiner.refine(draft, e.token);
  assert.equal(result.text, 'Improve the retry logic while preserving the API.');
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].messages.length, 2);
  assert.equal(JSON.parse(e.calls[0].messages[1].content), draft);
  assert.match(e.calls[0].messages[0].content, /Do not invent/);
  assert.match(e.calls[0].messages[0].content, /not responding/);
  assert.deepEqual(e.calls[0].options.tools, []);
  assert.equal(e.commands.length, 0);
});

test('model selection is remembered and changing it is explicit', async () => {
  const e = setup();
  await e.refiner.refine('draft one', e.token);
  await e.refiner.refine('draft two', e.token);
  assert.equal(e.picks, 1);
  assert.equal(e.refiner.modelName, e.model.name);
  await e.refiner.selectModel(e.token, true);
  assert.equal(e.picks, 2);
});

test('empty/oversized drafts fail before model discovery', async () => {
  const e = setup();
  for (const draft of ['', '  ', null, 'x'.repeat(12001)]) await assert.rejects(e.refiner.refine(draft, e.token));
  assert.equal(e.selections, 0);
});

test('missing models, unavailable remembered model, and dismissed picker are handled', async () => {
  const e = setup();
  e.vscode.lm.selectChatModels = async () => [];
  await assert.rejects(e.refiner.refine('draft', e.token), /No Copilot models/);
  e.vscode.lm.selectChatModels = async () => [e.model];
  e.memory.set('promptRefiner.model', 'removed');
  e.vscode.window.showQuickPick = async (_items, options) => { assert.match(options.placeHolder, /unavailable/); return undefined; };
  assert.equal(await e.refiner.refine('draft', e.token), undefined);
  assert.equal(e.calls.length, 0);
});

test('model token budget is checked before generation', async () => {
  const e = setup();
  e.model.countTokens = async () => 2100;
  await assert.rejects(e.refiner.refine('draft', e.token), /input budget/);
  assert.equal(e.calls.length, 0);
  e.model.maxInputTokens = 100;
  e.model.countTokens = async () => 60;
  await assert.rejects(e.refiner.refine('draft', e.token), /input budget/);
});

test('empty, excessively long, and interrupted streams never produce a usable partial rewrite', async () => {
  const e = setup();
  e.reply = '   ';
  await assert.rejects(e.refiner.refine('draft', e.token), /empty rewrite/);
  e.reply = 'x'.repeat(16001);
  await assert.rejects(e.refiner.refine('draft', e.token), /too long/);
  e.model.sendRequest = async () => ({ text: (async function* () { yield 'partial'; throw new Error('network interrupted'); })() });
  await assert.rejects(e.refiner.refine('draft', e.token), /network interrupted/);
});

test('cancellation settles even when a provider stalls or ignores the token', async () => {
  const e = setup();
  e.model.sendRequest = () => new Promise(() => {});
  const pending = e.refiner.refine('draft', e.token);
  await tick();
  e.cancellation.cancel();
  await assert.rejects(pending, /Cancel/i);
  assert.equal(e.commands.length, 0);
});

test('insertion stages an unsent prompt without switching mode or model', async () => {
  const e = setup();
  const prompt = 'Fix src/index.ts without changing the public API.';
  await e.api.insertCopilotDraft(prompt);
  assert.deepEqual(e.commands, [['workbench.action.chat.open', { query: prompt, isPartialQuery: true }]]);
  for (const bad of ['', ' ', null, 'x'.repeat(16001)]) await assert.rejects(e.api.insertCopilotDraft(bad));
  assert.equal(e.commands.length, 1);
});

test('consent, quota and model errors have actionable messages', () => {
  const e = setup();
  assert.match(e.api.refinementError({ code: 'NoPermissions' }), /not granted/);
  assert.match(e.api.refinementError({ code: 'Blocked' }), /quota/);
  assert.match(e.api.refinementError({ code: 'NotFound' }), /Change model/);
});

test('controller cancels superseded operations and suppresses late replies', async () => {
  const e = setup(), messages = [];
  const controller = new e.api.PromptRefinerController(e.state, message => messages.push(message));
  let release;
  e.model.sendRequest = async messages => {
    const text = JSON.parse(messages[1].content);
    return { text: (async function* () { if (text === 'first') await new Promise(resolve => { release = resolve; }); yield text + ' rewritten'; })() };
  };
  const first = controller.handle({ type: 'refinePrompt', requestId: '1', draft: 'first' });
  await tick();
  await controller.handle({ type: 'refinePrompt', requestId: '2', draft: 'second' });
  await first;
  release(); await tick();
  assert.deepEqual(messages.filter(message => message.type === 'refinerResult').map(message => message.requestId), ['2']);
  controller.dispose();
});

test('controller disposal/cancellation preserve the draft and never submit to the agent', async () => {
  const e = setup(), messages = [];
  const controller = new e.api.PromptRefinerController(e.state, message => messages.push(message));
  assert.equal(await controller.handle({ type: 'searchQuery' }), false);
  e.model.sendRequest = () => new Promise(() => {});
  const pending = controller.handle({ type: 'refinePrompt', requestId: '1', draft: 'draft' });
  await tick(); controller.dispose(); await pending;
  assert.equal(messages.length, 0);
  assert.equal(e.commands.length, 0);
});

test('controller timeout reports the failure without retaining a partial rewrite', async () => {
  const e = setup(), messages = [];
  const controller = new e.api.PromptRefinerController(e.state, message => messages.push(message));
  e.model.sendRequest = () => new Promise(() => {});
  const original = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => original(callback, delay === 90000 ? 15 : delay, ...args);
  try {
    await controller.handle({ type: 'refinePrompt', requestId: 'timeout', draft: 'my original draft' });
    assert.match(messages.find(message => message.type === 'refinerError').message, /timed out/);
    assert.equal(messages.some(message => message.type === 'refinerResult'), false);
    assert.equal(e.commands.length, 0);
  } finally { global.setTimeout = original; controller.dispose(); }
});
