'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseLrc, lineAt } = require('../src/shared/lrc');

const SAMPLE = `[ar: Кто-то]
[ti: Песня]
[00:01.55] Первая строка
[00:18.97] Вторая строка
[01:01.87] Третья строка
`;

test('титры: из файла берутся только строки со временем', () => {
  const lines = parseLrc(SAMPLE);
  assert.equal(lines.length, 3, 'заголовки [ar:] и [ti:] — про песню, а не про момент в ней');
  assert.deepEqual(lines[0], { at: 1.55, text: 'Первая строка' });
  assert.equal(lines[2].at, 61.87, 'минуты разворачиваются в секунды');
});

test('титры: сотые и тысячные считаются по числу цифр', () => {
  assert.equal(parseLrc('[00:00.5] а')[0].at, 0.5);
  assert.equal(parseLrc('[00:00.05] а')[0].at, 0.05);
  assert.equal(parseLrc('[00:00.050] а')[0].at, 0.05);
});

test('титры: двоеточие перед долями читается как точка', () => {
  assert.equal(parseLrc('[01:02:30] а')[0].at, 62.3);
});

test('титры: время может идти и без долей секунды', () => {
  assert.deepEqual(parseLrc('[02:07] Строка')[0], { at: 127, text: 'Строка' });
});

test('титры: строки выстраиваются по времени, даже если в файле вперемешку', () => {
  const lines = parseLrc('[00:30.00] вторая\n[00:10.00] первая\n[01:00.00] третья');
  assert.deepEqual(lines.map((l) => l.text), ['первая', 'вторая', 'третья']);
});

test('титры: пустая строка со временем сохраняется — это пауза в пении', () => {
  const lines = parseLrc('[00:05.00] поют\n[00:09.00]\n[00:20.00] снова поют');
  assert.equal(lines.length, 3);
  assert.equal(lines[1].text, '', 'иначе на проигрыше висела бы предыдущая строка');
});

test('титры: мусор вместо файла не роняет разбор', () => {
  for (const junk of ['', null, undefined, 'просто текст без времени', '[ar: только заголовок]']) {
    assert.deepEqual(parseLrc(junk), []);
  }
});

// ── какая строка звучит сейчас ──────────────────────────────────────────────
const LINES = parseLrc(SAMPLE);

test('строка: до первой реплики не показывается ничего', () => {
  assert.equal(lineAt(LINES, 0), -1, 'на вступлении первую строку показывать рано');
  assert.equal(lineAt(LINES, 1.54), -1);
});

test('строка: ровно на своей секунде строка уже текущая', () => {
  assert.equal(lineAt(LINES, 1.55), 0);
  assert.equal(lineAt(LINES, 18.97), 1);
});

test('строка: держится до следующей, а последняя — до конца песни', () => {
  assert.equal(lineAt(LINES, 10), 0);
  assert.equal(lineAt(LINES, 61.86), 1);
  assert.equal(lineAt(LINES, 9999), 2);
});

test('строка: без титров и без времени спрашивать нечего', () => {
  assert.equal(lineAt([], 5), -1);
  assert.equal(lineAt(null, 5), -1);
  assert.equal(lineAt(LINES, NaN), -1);
});
