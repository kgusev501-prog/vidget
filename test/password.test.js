'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { generate, SETS, AMBIGUOUS } = require('../src/shared/password');

test('пароль: нужной длины и в заданных границах', () => {
  assert.equal(generate({ length: 20 }).length, 20);
  assert.equal(generate({ length: 4 }).length, 4);
  assert.equal(generate({ length: 1 }).length, 4, 'слишком короткий поднимается до минимума');
  assert.equal(generate({ length: 500 }).length, 128, 'слишком длинный обрезается');
  assert.equal(generate().length, 20);
});

test('пароль: содержит по одному знаку каждого затребованного вида', () => {
  // A site that demands a digit should not send the user back to press the
  // button again, so each kind asked for is guaranteed to appear.
  for (let i = 0; i < 40; i++) {
    const pw = generate({ length: 8, lower: true, upper: true, digits: true, symbols: true });
    assert.ok([...pw].some((c) => SETS.lower.includes(c)), pw);
    assert.ok([...pw].some((c) => SETS.upper.includes(c)), pw);
    assert.ok([...pw].some((c) => SETS.digits.includes(c)), pw);
    assert.ok([...pw].some((c) => SETS.symbols.includes(c)), pw);
  }
});

test('пароль: невыбранные виды знаков не появляются', () => {
  for (let i = 0; i < 30; i++) {
    const pw = generate({ length: 24, lower: true, upper: false, digits: false, symbols: false });
    assert.match(pw, /^[a-z]+$/);
  }
});

test('пароль: похожие знаки убираются по требованию', () => {
  for (let i = 0; i < 30; i++) {
    const pw = generate({ length: 40, readable: true });
    for (const c of pw) assert.ok(!AMBIGUOUS.has(c), `${c} в ${pw}`);
  }
});

test('пароль: без единого выбранного вида всё равно что-то выходит', () => {
  const pw = generate({ length: 12, lower: false, upper: false, digits: false, symbols: false });
  assert.equal(pw.length, 12);
  assert.match(pw, /^[A-Za-z]+$/);
});

test('пароль: два вызова не совпадают', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(generate({ length: 16 }));
  assert.equal(seen.size, 200);
});

test('пароль: обязательные знаки не липнут к началу', () => {
  // Built by putting one of each kind first and then shuffling; without the
  // shuffle every password would start with a lowercase letter.
  let digitFirst = 0;
  for (let i = 0; i < 200; i++) {
    if (SETS.digits.includes(generate({ length: 8 })[0])) digitFirst++;
  }
  assert.ok(digitFirst > 5, `цифра оказывалась первой ${digitFirst} раз из 200`);
});
