'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { describe: describeFiles, basename } = require('../src/shared/file-list');

const fileStat = (size) => ({ isDirectory: () => false, size });
const dirStat = () => ({ isDirectory: () => true, size: 4096 });

const paths = (n, prefix = 'C:\\big\\f') => Array.from({ length: n }, (_, i) => `${prefix}${i}.bin`);

test('reads size and kind for a small selection', async () => {
  const out = await describeFiles(['C:\\a\\one.txt', 'C:\\a\\sub'], {
    stat: async (p) => (p.endsWith('sub') ? dirStat() : fileStat(1234)),
  });
  assert.deepStrictEqual(out[0], { path: 'C:\\a\\one.txt', name: 'one.txt', dir: false, size: 1234 });
  assert.deepStrictEqual(out[1], { path: 'C:\\a\\sub', name: 'sub', dir: true, size: 0 });
});

test('a folder reports no size of its own', async () => {
  const [entry] = await describeFiles(['C:\\a\\sub'], { stat: async () => dirStat() });
  assert.strictEqual(entry.size, 0, 'a folder is not measured by walking it');
});

test('a path that cannot be read is marked missing, not dropped', async () => {
  const out = await describeFiles(['C:\\gone.txt'], {
    stat: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].missing, true);
  assert.strictEqual(out[0].path, 'C:\\gone.txt');
});

test('every path comes back, however many there are', async () => {
  const out = await describeFiles(paths(5000), { stat: async () => fileStat(1) });
  assert.strictEqual(out.length, 5000);
  assert.strictEqual(out[4999].path, 'C:\\big\\f4999.bin');
});

test('stops asking the filesystem past the limit', async () => {
  let asked = 0;
  const out = await describeFiles(paths(100000), {
    stat: async () => {
      asked++;
      return fileStat(1);
    },
    limit: 200,
  });
  assert.strictEqual(asked, 200, 'a hundred thousand files cost two hundred lookups');
  assert.strictEqual(out.length, 100000, 'and all of them are still remembered');
});

test('paths past the limit are marked unread rather than missing', async () => {
  const out = await describeFiles(paths(300), { stat: async () => fileStat(7), limit: 200 });
  assert.strictEqual(out[199].size, 7);
  assert.strictEqual(out[199].unread, undefined);
  assert.strictEqual(out[250].unread, true, 'we did not ask, which is not the same as absent');
  assert.strictEqual(out[250].missing, undefined);
  assert.strictEqual(out[250].path, 'C:\\big\\f250.bin', 'the path is what restoring needs');
});

test('yields between chunks so the panel keeps responding', async () => {
  let breaths = 0;
  await describeFiles(paths(200), {
    stat: async () => fileStat(1),
    breathe: async () => {
      breaths++;
    },
    limit: 200,
    chunk: 50,
  });
  assert.strictEqual(breaths, 4, 'one breath per chunk of fifty');
});

test('never yields for a selection smaller than a chunk', async () => {
  let breaths = 0;
  await describeFiles(paths(3), {
    stat: async () => fileStat(1),
    breathe: async () => {
      breaths++;
    },
    chunk: 50,
  });
  assert.strictEqual(breaths, 0, 'copying three files should not go round the loop');
});

test('an empty selection produces nothing and asks nothing', async () => {
  let asked = 0;
  const out = await describeFiles([], {
    stat: async () => {
      asked++;
      return fileStat(1);
    },
  });
  assert.deepStrictEqual(out, []);
  assert.strictEqual(asked, 0);
});

test('order is preserved — the first file copied is the first shown', async () => {
  const given = ['C:\\z.txt', 'C:\\a.txt', 'C:\\m.txt'];
  const out = await describeFiles(given, { stat: async () => fileStat(1) });
  assert.deepStrictEqual(out.map((e) => e.path), given);
});

test('basename copes with both slashes, trailing ones, and bare roots', () => {
  assert.strictEqual(basename('C:\\a\\b\\file.txt'), 'file.txt');
  assert.strictEqual(basename('C:/a/b/file.txt'), 'file.txt');
  assert.strictEqual(basename('file.txt'), 'file.txt');
  assert.strictEqual(basename('C:\\'), 'C:\\', 'nothing after the slash: keep the path itself');
});

test('a name is always present, so a card never renders blank', async () => {
  const out = await describeFiles(['C:\\', '\\\\server\\share\\doc.pdf'], { stat: async () => dirStat() });
  assert.ok(out.every((e) => e.name && e.name.length), out.map((e) => e.name).join(' | '));
  assert.strictEqual(out[1].name, 'doc.pdf');
});
