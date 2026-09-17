'use strict';

const test = require('node:test');
const assert = require('node:assert');

const md = require('../src/shared/markdown');
const edit = require('../src/shared/md-edit');

const joined = (line) => line.indent + line.marker + line.segments.map((s) => s.text).join('');
const visible = (line) => line.segments.filter((s) => !s.mark).map((s) => s.text).join('');

// The live editor finds the caret again by counting characters, so the one
// thing that must never break: the pieces of a line add up to the line.
test('разбор: куски строки всегда складываются в исходный текст', () => {
  const samples = [
    '',
    '   ',
    'простой текст',
    '# Заголовок',
    '### Третий **жирный**',
    '- пункт',
    '  * вложенный _курсив_ и `код`',
    '1. первый',
    '12) двенадцатый',
    '- [ ] дело',
    '- [x] сделано ~~зачёркнуто~~',
    '> цитата со [ссылкой](https://example.com)',
    '---',
    '**незакрытый жирный',
    'snake_case_name и 2*3*4',
    '***жирный курсив***',
    '`код с **звёздами** внутри`',
    '[не ссылка](javascript:alert(1))',
    '#без пробела',
  ];
  for (const raw of samples) {
    const line = md.parseLine(raw);
    assert.equal(joined(line), raw, `строка «${raw}» (${line.kind})`);
  }
  const note = 'Шапка\n```js\nconst a = **1**;\n```\n- [ ] потом';
  assert.equal(md.parse(note).map(joined).join('\n'), note);
});

test('разбор: виды строк', () => {
  const kinds = (text) => md.parse(text).map((l) => l.kind);
  assert.deepEqual(kinds('# А\n\n- б\n1. в\n- [x] г\n> д\n---\nе'), [
    'heading', 'blank', 'bullet', 'ordered', 'task', 'quote', 'rule', 'text',
  ]);
  assert.equal(md.parseLine('## Два').level, 2);
  assert.equal(md.parseLine('7. семь').number, 7);
  assert.equal(md.parseLine('- [x] да').checked, true);
  assert.equal(md.parseLine('- [ ] нет').checked, false);
  assert.equal(md.parseLine('- [х] русская х').checked, true, 'русская «х» в раскладке тоже отмечает');
  assert.equal(md.parseLine('#хэштег').kind, 'text', 'без пробела после решётки это не заголовок');
});

test('разбор: внутри блока кода разметки нет', () => {
  const lines = md.parse('```\n# не заголовок\n**не жирный**\n```\n**жирный**');
  assert.deepEqual(lines.map((l) => l.kind), ['fence', 'code', 'code', 'fence', 'text']);
  assert.ok(lines[2].segments.every((s) => !s.mark));
  assert.ok(lines[4].segments.some((s) => s.styles.includes('b')));
});

test('разбор: начертания внутри строки', () => {
  const styleOf = (raw, word) => md.parseLine(raw).segments.find((s) => !s.mark && s.text.includes(word)).styles;
  assert.deepEqual(styleOf('a **жир** b', 'жир'), ['b']);
  assert.deepEqual(styleOf('a *кур* b', 'кур'), ['i']);
  assert.deepEqual(styleOf('a _кур_ b', 'кур'), ['i']);
  assert.deepEqual(styleOf('a ~~зач~~ b', 'зач'), ['s']);
  assert.deepEqual(styleOf('a `код` b', 'код'), ['code']);
  assert.deepEqual(styleOf('**жир и *кур***', 'кур'), ['b', 'i']);
  assert.deepEqual(styleOf('snake_case_name', 'snake'), [], 'подчёркивания в словах не курсив');
  assert.deepEqual(styleOf('`**не жирный**`', 'не жирный'), ['code']);
});

test('разбор: ссылки только на http, https и почту', () => {
  const good = md.parseLine('см. [сайт](https://example.com/a?b=1)');
  const link = good.segments.find((s) => !s.mark && s.styles.includes('link'));
  assert.equal(link.text, 'сайт');
  assert.equal(link.href, 'https://example.com/a?b=1');
  assert.equal(visible(good), 'см. сайт');

  const bad = md.parseLine('[жми](javascript:alert(1))');
  assert.ok(!bad.segments.some((s) => s.href), 'javascript: ссылкой не становится');
});

test('разбор: заголовок заметки без разметки', () => {
  assert.equal(md.plainLine('# **Список** покупок'), 'Список покупок');
  assert.equal(md.plainLine('- [ ] купить `молоко`'), 'купить молоко');
  assert.equal(md.plainLine('---'), '');
});

// ── editing ────────────────────────────────────────────────────────────────
const at = (text) => {
  const pos = text.indexOf('|');
  return { text: text.replace('|', ''), pos };
};
const show = (r) => r.text.slice(0, r.start) + '|' + r.text.slice(r.start);

test('Shift+Enter: пункт списка продолжается тем же значком', () => {
  let t = at('- молоко|');
  assert.equal(show(edit.newLine(t.text, t.pos)), '- молоко\n- |');
  t = at('  * вложенный|');
  assert.equal(show(edit.newLine(t.text, t.pos)), '  * вложенный\n  * |');
  t = at('9. девятый|');
  assert.equal(show(edit.newLine(t.text, t.pos)), '9. девятый\n10. |', 'номер растёт');
  t = at('- [x] сделано|');
  assert.equal(show(edit.newLine(t.text, t.pos)), '- [x] сделано\n- [ ] |', 'новая галочка пустая');
});

test('Shift+Enter дважды: пустой пункт превращается в обычную строку', () => {
  const first = edit.newLine('- хлеб', 6);
  assert.equal(show(first), '- хлеб\n- |');
  const second = edit.newLine(first.text, first.start);
  assert.equal(show(second), '- хлеб\n|', 'значок снят, список закончен');
});

test('Shift+Enter: вне списка — просто новая строка', () => {
  const t = at('обычный| текст');
  assert.equal(show(edit.newLine(t.text, t.pos)), 'обычный\n| текст');
  const inMarker = edit.newLine('- пункт', 1);
  assert.equal(inMarker.text, '-\n пункт', 'курсор внутри значка — список не продолжается');
});

test('Ctrl+B и Ctrl+I: обернуть выделение и снять обёртку', () => {
  let r = edit.toggleWrap('сделать важное дело', 8, 14, '**');
  assert.equal(r.text, 'сделать **важное** дело');
  assert.equal(r.text.slice(r.start, r.end), 'важное', 'выделение остаётся на слове');
  r = edit.toggleWrap(r.text, r.start, r.end, '**');
  assert.equal(r.text, 'сделать важное дело', 'второе нажатие снимает');

  r = edit.toggleWrap('a **жир** b', 2, 9, '**');
  assert.equal(r.text, 'a жир b', 'выделено вместе со звёздами — тоже снимает');

  r = edit.toggleWrap('слово', 0, 5, '*');
  assert.equal(r.text, '*слово*');
  r = edit.toggleWrap('**слово**', 2, 7, '*');
  assert.equal(r.text, '***слово***', 'курсив поверх жирного не путается с жирным');
  r = edit.toggleWrap(r.text, 3, 8, '*');
  assert.equal(r.text, '**слово**');

  r = edit.toggleWrap(' слово ', 0, 7, '**');
  assert.equal(r.text, ' **слово** ', 'пробелы по краям остаются снаружи');
});

test('Ctrl+B без выделения: пара звёзд и курсор между ними', () => {
  const r = edit.toggleWrap('ab', 1, 1, '**');
  assert.equal(show(r), 'a**|**b');
  const back = edit.toggleWrap(r.text, r.start, r.end, '**');
  assert.equal(show(back), 'a|b', 'повторное нажатие убирает пустую пару');
});

test('галочка: клик меняет только свою строку', () => {
  const note = 'Дела\n- [ ] одно\n- [x] другое\nтекст';
  assert.equal(edit.toggleTask(note, 1), 'Дела\n- [x] одно\n- [x] другое\nтекст');
  assert.equal(edit.toggleTask(note, 2), 'Дела\n- [ ] одно\n- [ ] другое\nтекст');
  assert.equal(edit.toggleTask(note, 3), note, 'не галочка — без изменений');
  assert.equal(edit.toggleTask(note, 99), note);
});

test('разбор: простой адрес без разметки тоже ссылка', () => {
  const line = md.parseLine('см. https://github.com/kgusev501-prog/vidget.');
  const link = line.segments.find((s) => s.href);
  assert.equal(link.text, 'https://github.com/kgusev501-prog/vidget', 'точка в конце — от предложения');
  assert.equal(link.href, link.text);
  assert.ok(!line.segments.some((s) => s.mark), 'прятать нечего');
  assert.equal(joined(line), 'см. https://github.com/kgusev501-prog/vidget.');

  const www = md.parseLine('www.example.com/a_b_c, дальше').segments.find((s) => s.href);
  assert.equal(www.href, 'https://www.example.com/a_b_c', 'www получает https, подчёркивания не курсив');

  assert.ok(!md.parseLine('почта a@www.b.com').segments.some((s) => s.href), 'часть адреса почты — не ссылка');
  assert.ok(!md.parseLine('javascript:alert(1)').segments.some((s) => s.href));
  assert.ok(!md.parseLine('`https://в.коде`').segments.some((s) => s.href), 'в коде адрес остаётся кодом');
});
