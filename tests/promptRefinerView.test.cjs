const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function view(saved = {}) {
  const html = fs.readFileSync(require.resolve('../src/webview/refiner.html'), 'utf8');
  const elements = new Map(), messages = [], copied = [];
  let persisted = saved, receive;
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    elements.set(match[1], {
      value: '', textContent: '', innerHTML: '', disabled: false, hidden: false, style: {}, listeners: new Map(),
      classList: { toggle() {} },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      async fire(name, event = {}) { await this.listeners.get(name)?.(event); },
      querySelectorAll() { return []; }, focus() { this.focused = true; }, scrollIntoView() {},
    });
  }
  const context = {
    document: { getElementById: id => { assert.ok(elements.has(id), id); return elements.get(id); } },
    window: { addEventListener: (name, callback) => { if (name === 'message') receive = callback; } },
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    acquireVsCodeApi: () => ({ getState: () => persisted, setState: value => { persisted = value; }, postMessage: value => messages.push(value) }),
    setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { elements, messages, copied, get state() { return persisted; }, send: data => receive({ data }),
    get: id => elements.get(id), input: async (id, value) => { elements.get(id).value = value; await elements.get(id).fire('input'); } };
}

test('draft composer is available without an index and does not contact a model while typing', async () => {
  const e = view();
  await e.send({ type: 'init', hasWorkspace: false });
  assert.equal(e.get('btn-build').disabled, true);
  await e.input('prompt-draft', 'make retries clearer');
  assert.equal(e.get('btn-refine').disabled, false);
  assert.equal(e.messages.some(message => message.type === 'refinePrompt'), false);
  assert.equal(e.state.draft, 'make retries clearer');
});

test('refinement displays an editable rewrite and insertion is a separate explicit click', async () => {
  const e = view();
  await e.input('prompt-draft', 'draft');
  await e.get('btn-refine').fire('click');
  const request = e.messages.find(message => message.type === 'refinePrompt');
  assert.equal(request.draft, 'draft');
  assert.equal(e.get('btn-insert-prompt').disabled, true);
  await e.send({ type: 'refinerResult', requestId: request.requestId, text: 'Clear revised prompt' });
  assert.equal(e.get('prompt-refined').value, 'Clear revised prompt');
  assert.equal(e.get('btn-insert-prompt').disabled, false);
  assert.equal(e.messages.some(message => message.type === 'insertCopilotDraft'), false);
  await e.input('prompt-refined', 'Reviewed revised prompt');
  await e.get('btn-insert-prompt').fire('click');
  assert.equal(e.messages.at(-1).text, 'Reviewed revised prompt');
  await e.get('btn-copy-prompt').fire('click');
  assert.deepEqual(e.copied, ['Reviewed revised prompt']);
});

test('editing a draft cancels the old request and late responses cannot replace it', async () => {
  const e = view();
  await e.input('prompt-draft', 'first draft');
  await e.get('btn-refine').fire('click');
  const request = e.messages.at(-1);
  await e.input('prompt-draft', 'newer draft');
  assert.equal(e.messages.at(-1).type, 'cancelRefinement');
  await e.send({ type: 'refinerResult', requestId: request.requestId, text: 'obsolete rewrite' });
  assert.equal(e.get('prompt-draft').value, 'newer draft');
  assert.equal(e.get('prompt-refined').value, '');
  assert.equal(e.get('btn-refine').disabled, false);
});

test('failure preserves the original draft and view state restores editable contents', async () => {
  const e = view({ draft: 'saved draft', refined: 'saved rewrite' });
  assert.equal(e.get('prompt-draft').value, 'saved draft');
  assert.equal(e.get('prompt-refined').value, 'saved rewrite');
  await e.get('btn-refine').fire('click');
  const request = e.messages.at(-1);
  await e.send({ type: 'refinerError', requestId: request.requestId, message: 'Quota exhausted; draft kept.' });
  assert.equal(e.get('prompt-draft').value, 'saved draft');
  assert.equal(e.get('prompt-refined').value, 'saved rewrite');
  assert.match(e.get('status').textContent, /Quota/);
  assert.equal(e.get('btn-refine').disabled, false);
});
