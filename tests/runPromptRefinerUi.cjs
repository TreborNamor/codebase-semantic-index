const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadTs } = require('./helpers.cjs');
const { mockVscode } = require('./mockVscode.cjs');

async function main() {
  const browser = await chromium.launch({ headless: true });
  let controller;
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const { vscode } = mockVscode();
    const values = new Map(), commands = [];
    let draftSent, delayed, release, available = true;
    const model = {
      id: 'refiner-ui-test', name: 'Mock Copilot model', maxInputTokens: 32000,
      countTokens: async () => 100,
      sendRequest: async messages => {
        draftSent = JSON.parse(messages[1].content);
        return { text: (async function* () {
          if (delayed) await new Promise(resolve => { release = resolve; });
          yield 'Find the retry implementation in src/index.ts. Preserve the public API.';
        })() };
      },
    };
    vscode.lm = { selectChatModels: async () => available ? [model] : [] };
    vscode.LanguageModelChatMessage = { User: content => ({ content }) };
    vscode.window = { showQuickPick: async items => items[0] };
    vscode.commands.executeCommand = async (...args) => commands.push(args);
    const { PromptRefinerController } = loadTs('src/promptRefiner.ts', { vscode });
    controller = new PromptRefinerController({ get: key => values.get(key), update: async (key, value) => values.set(key, value) },
      message => { void page.evaluate(message => window.postMessage(message, '*'), message).catch(() => {}); });
    await page.exposeFunction('sendToExtension', message => controller.handle(message));
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({
        getState: () => window.savedDraft ?? {},
        setState: value => { window.savedDraft = value; },
        postMessage: message => { void window.sendToExtension(message); },
      });
    });
    const html = fs.readFileSync(path.join(__dirname, '../src/webview/panel.html'), 'utf8').replace('__CSP_SOURCE__', "'self'");
    await page.setContent(html);
    const draft = page.getByLabel('Your draft', { exact: true });
    const result = page.getByLabel('Revised prompt (review and edit)', { exact: true });
    await draft.fill('find retries in src/index.ts please dont change public api');
    await page.getByRole('button', { name: 'Refine Prompt', exact: true }).click();
    await result.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('prompt-refined').value.startsWith('Find the retry'));
    assert.equal(draftSent, 'find retries in src/index.ts please dont change public api');
    assert.equal(commands.length, 0, 'refining must not call the coding agent');
    assert.equal(await draft.inputValue(), draftSent);
    await result.fill('Reviewed rewrite for the coding agent.');
    await page.getByRole('button', { name: 'Insert into Copilot', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('refiner-status').textContent.includes('unsent draft'));
    assert.deepEqual(commands, [['workbench.action.chat.open', { query: 'Reviewed rewrite for the coding agent.', isPartialQuery: true }]]);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'narrow sidebar must not overflow horizontally');
    fs.mkdirSync(path.join(__dirname, '../dist/test'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../dist/test/prompt-refiner.png'), fullPage: true });

    delayed = true;
    await draft.fill('first draft');
    await page.getByRole('button', { name: 'Refine Prompt', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('refiner-status').textContent.includes('Refining'));
    // Wait until the mock stream is actually awaiting its release.
    const deadline = Date.now() + 5000;
    while (!release && Date.now() < deadline) await page.waitForTimeout(10);
    assert.ok(release);
    await draft.fill('newer draft');
    release();
    await page.waitForTimeout(100);
    assert.equal(await result.inputValue(), '');
    assert.equal(await draft.inputValue(), 'newer draft');
    available = false;
    await page.getByRole('button', { name: 'Refine Prompt', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('refiner-status').textContent.includes('No Copilot models'));
    assert.equal(await draft.inputValue(), 'newer draft');
    assert.deepEqual(errors, []);
    console.log('Prompt-refiner browser UI passed: rewrite/review, unsent insertion, stale-response cancellation, missing-model error, and narrow layout. Model responses were mocked; no paid request was sent.');
  } finally { controller?.dispose(); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
