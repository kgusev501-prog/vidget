'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { planEviction, usage, DEFAULT_BUDGET } = require('../src/shared/image-budget');

const MB = 1024 * 1024;

/** Newest first, the way the history is actually stored. */
const img = (id, mb, ts, pinned = false) => ({ id, type: 'image', bytes: mb * MB, ts, pinned });
const text = (id, ts) => ({ id, type: 'text', text: 'x', ts });

test('a folder inside its budget loses nothing', () => {
  const items = [img('a', 100, 3), img('b', 100, 2), img('c', 100, 1)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop, []);
  assert.strictEqual(plan.total, 300 * MB);
});

test('over budget, the oldest picture goes first', () => {
  const items = [img('new', 300, 3), img('mid', 300, 2), img('old', 600, 1)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop.map((i) => i.id), ['old'], 'one is enough, so only one goes');
  assert.strictEqual(plan.kept, 600 * MB);
});

test('drops as many as it takes and then stops', () => {
  const items = [img('d', 400, 4), img('c', 400, 3), img('b', 400, 2), img('a', 400, 1)];
  const plan = planEviction(items, 800 * MB);
  assert.deepStrictEqual(plan.drop.map((i) => i.id), ['a', 'b']);
  assert.strictEqual(plan.kept, 800 * MB);
});

test('a pinned picture is never given up, however old', () => {
  // The pinned one is the oldest, so without the rule it would go first.
  const items = [img('new', 600, 3), img('mid', 600, 2), img('ancient', 100, 1, true)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop.map((i) => i.id), ['mid'], 'the oldest unpinned goes instead');
  assert.strictEqual(plan.kept, 700 * MB);
});

test('when the unpinned ones are not enough, it sheds as many as it can', () => {
  const items = [img('new', 900, 3), img('mid', 900, 2), img('ancient', 900, 1, true)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop.map((i) => i.id), ['mid', 'new'], 'both unpinned, oldest first');
  assert.strictEqual(plan.kept, 900 * MB, 'what is left is the pinned one, over budget and staying');
});

test('pinned pictures alone can exceed the budget without anything being dropped', () => {
  const items = [img('a', 2000, 2, true), img('b', 2000, 1, true)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop, [], 'nothing pinned is ever thrown away');
  assert.strictEqual(plan.kept, 4000 * MB);
});

test('text and file entries are not touched and do not count toward the budget', () => {
  const items = [text('t1', 5), img('big', 3000, 4), text('t2', 3)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop.map((i) => i.id), ['big']);
  assert.strictEqual(plan.total, 3000 * MB, 'only pictures are weighed');
});

test('an entry still being written counts as nothing until its size is known', () => {
  const items = [{ id: 'p', type: 'image', bytes: 0, pending: true, ts: 2 }, img('a', 100, 1)];
  const plan = planEviction(items, 1024 * MB);
  assert.deepStrictEqual(plan.drop, []);
  assert.strictEqual(plan.total, 100 * MB);
});

test('an empty history is fine', () => {
  const plan = planEviction([], 1024 * MB);
  assert.deepStrictEqual(plan.drop, []);
  assert.strictEqual(plan.total, 0);
});

test('the default budget is 2 GB', () => {
  assert.strictEqual(DEFAULT_BUDGET, 2 * 1024 * MB);
});

test('the default applies when no budget is given', () => {
  const items = [img('a', 1500, 2), img('b', 1500, 1)];
  assert.deepStrictEqual(planEviction(items).drop.map((i) => i.id), ['b']);
});

test('usage counts only pictures', () => {
  assert.strictEqual(usage([img('a', 5, 2), text('t', 1), img('b', 7, 3)]), 12 * MB);
  assert.strictEqual(usage([]), 0);
});

test('a malformed entry does not bring the sweep down', () => {
  assert.doesNotThrow(() => planEviction([null, undefined, img('a', 1, 1)], 1024 * MB));
  assert.strictEqual(usage([null, img('a', 3, 1)]), 3 * MB);
});
