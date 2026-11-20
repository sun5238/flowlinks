const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GraphPersistence } = require('../src/persistence');

test('burst of edits coalesces to one latest-state write', async () => {
  let value = 0;
  const saved = [];
  const writer = new GraphPersistence(() => ({ value }), async state => { saved.push(state.value); }, () => {}, 20);
  for (let i = 1; i <= 1000; i++) { value = i; writer.schedule(); }
  await writer.flush();
  assert.deepEqual(saved, [1000]);
});

test('a change during a slow write is saved without an unbounded queue', async () => {
  let value = 1;
  const saved = [];
  let complete;
  const writer = new GraphPersistence(() => ({ value }), async state => {
    saved.push(state.value);
    if (saved.length === 1) await new Promise(resolve => { complete = resolve; });
  }, () => {}, 1);
  writer.schedule();
  const flushing = writer.flush();
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 2; i <= 500; i++) { value = i; writer.schedule(); }
  complete();
  await flushing;
  assert.deepEqual(saved, [1, 500]);
});

test('persistence failures are reported without stopping future writes', async () => {
  let attempts = 0;
  let reported = 0;
  const writer = new GraphPersistence(() => ({}), async () => {
    if (++attempts === 1) throw new Error('disk full');
  }, () => { reported++; });
  writer.schedule();
  await writer.flush();
  writer.schedule();
  await writer.flush();
  assert.equal(attempts, 2);
  assert.equal(reported, 1);
});
