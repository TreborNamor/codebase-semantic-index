const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers.cjs');
const { ReconcileQueue } = loadTs('src/reconcileQueue.ts');

test('updates queued during an outstanding build run after it', async () => {
  let release; let calls = 0;
  const queue = new ReconcileQueue(async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); });
  const first = queue.request();
  await new Promise(resolve => setImmediate(resolve));
  const second = queue.request(); queue.request();
  release(); await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test('a failed forced build retains its force flag and pending work', async () => {
  const flags = [];
  const queue = new ReconcileQueue(async force => { flags.push(force); if (flags.length === 1) throw new Error('transient'); });
  await assert.rejects(queue.request(true), /transient/);
  await queue.request();
  assert.deepEqual(flags, [true, true]);
});

test('completion-microtask requests are drained rather than stranded', async () => {
  let calls = 0, second;
  const queue = new ReconcileQueue(async () => {
    calls++;
    if (calls === 1) queueMicrotask(() => queueMicrotask(() => { second = queue.request(); }));
  });
  await queue.request();
  await second;
  assert.equal(calls, 2);
  assert.equal(queue.busy, false);
});
