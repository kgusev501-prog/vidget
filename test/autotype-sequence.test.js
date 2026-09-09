'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parse, check, DEFAULT_SEQUENCE } = require('../src/shared/autotype-sequence');

test('последовательность: обычная по умолчанию', () => {
  assert.deepEqual(parse(DEFAULT_SEQUENCE), [
    { type: 'field', field: 'UserName' },
    { type: 'key', key: 'TAB' },
    { type: 'field', field: 'Password' },
    { type: 'key', key: 'ENTER' },
  ]);
});

test('последовательность: буквы между вставками остаются текстом', () => {
  assert.deepEqual(parse('логин: {USERNAME} готово'), [
    { type: 'text', value: 'логин: ' },
    { type: 'field', field: 'UserName' },
    { type: 'text', value: ' готово' },
  ]);
});

test('последовательность: все обычные поля записи', () => {
  const fields = parse('{TITLE}{USERNAME}{PASSWORD}{URL}{NOTES}{TOTP}').map((a) => a.field);
  assert.deepEqual(fields, ['Title', 'UserName', 'Password', 'URL', 'Notes', 'TOTP']);
});

test('последовательность: своё поле записи через S:', () => {
  assert.deepEqual(parse('{S:Кодовое слово}'), [{ type: 'field', field: 'Кодовое слово', custom: true }]);
});

test('последовательность: клавиши и их сокращения', () => {
  assert.deepEqual(parse('{TAB}{~}{BS}{DEL}{PGDN}{F5}{NUMPAD3}').map((a) => a.key), [
    'TAB',
    'ENTER',
    'BACKSPACE',
    'DELETE',
    'PGDN',
    'F5',
    'NUMPAD3',
  ]);
});

test('последовательность: модификатор относится к следующему знаку', () => {
  assert.deepEqual(parse('^v'), [{ type: 'key', key: 'CHAR:v', mods: ['ctrl'] }]);
  assert.deepEqual(parse('^a{DEL}'), [
    { type: 'key', key: 'CHAR:a', mods: ['ctrl'] },
    { type: 'key', key: 'DELETE' },
  ]);
  assert.deepEqual(parse('+{TAB}'), [{ type: 'key', key: 'TAB', mods: ['shift'] }]);
});

test('последовательность: модификатор перед скобками держится всю группу', () => {
  assert.deepEqual(parse('+(ab)'), [
    { type: 'key', key: 'CHAR:a', mods: ['shift'] },
    { type: 'key', key: 'CHAR:b', mods: ['shift'] },
  ]);
  assert.deepEqual(parse('+(a)b'), [
    { type: 'key', key: 'CHAR:a', mods: ['shift'] },
    { type: 'text', value: 'b' },
  ], 'после закрывающей скобки модификатор снят');
});

test('последовательность: паузa разовая и общая скорость печати', () => {
  assert.deepEqual(parse('{DELAY 250}'), [{ type: 'delay', ms: 250 }]);
  assert.deepEqual(parse('{DELAY=40}'), [{ type: 'rate', ms: 40 }]);
});

test('последовательность: очистка поля перед вводом', () => {
  assert.deepEqual(parse('{CLEARFIELD}{PASSWORD}'), [
    { type: 'clear' },
    { type: 'field', field: 'Password' },
  ]);
});

test('последовательность: скобки и знаки модификаторов как обычные буквы', () => {
  assert.deepEqual(parse('{{}{}}'), [{ type: 'text', value: '{}' }]);
  assert.deepEqual(parse('{+}{^}{%}'), [{ type: 'text', value: '+^%' }]);
});

// Anything not understood has to stop the sequence. Skipping an unknown step
// would type a password into whatever the previous step left focused.
test('последовательность: непонятное не пропускается молча', () => {
  assert.throws(() => parse('{ВСЁ ЧТО УГОДНО}'), /неизвестная вставка/);
  assert.throws(() => parse('{USERNAME'), /не закрыта скобка/);
  assert.throws(() => parse('{DELAY сколько-то}'), /непонятная задержка/);
  assert.throws(() => parse('текст^'), /ни к чему не относится/);
});

test('последовательность: проверка сообщает об ошибке, а не падает', () => {
  assert.deepEqual(check(DEFAULT_SEQUENCE), { ok: true });
  const bad = check('{НЕТ ТАКОГО}');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /неизвестная вставка/);
});

test('последовательность: пустая строка ничего не печатает', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse(null), []);
});
