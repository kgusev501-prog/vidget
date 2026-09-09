'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { matchesWindow, hostOf, scoreForWindow, forWindow, search } = require('../src/shared/entry-match');

test('окно: шаблон со звёздочкой, как в KeePass', () => {
  assert.equal(matchesWindow('GitHub — Google Chrome', '*GitHub*'), true);
  assert.equal(matchesWindow('GitHub — Google Chrome', 'GitHub*'), true);
  assert.equal(matchesWindow('Вход — GitHub', '*GitHub'), true);
  assert.equal(matchesWindow('Проводник', '*GitHub*'), false);
});

test('окно: без звёздочек совпадать должен весь заголовок', () => {
  assert.equal(matchesWindow('GitHub', 'GitHub'), true);
  assert.equal(matchesWindow('GitHub — Chrome', 'GitHub'), false, 'иначе шаблон ловил бы лишнее');
});

test('окно: регистр не важен', () => {
  assert.equal(matchesWindow('GITHUB — CHROME', '*github*'), true);
});

test('окно: знаки в заголовке не считаются за шаблон', () => {
  assert.equal(matchesWindow('App [dev] — вход', 'App [dev]*'), true);
  assert.equal(matchesWindow('GitXub', 'Git.ub'), false, 'точка это точка, а не любой знак');
  assert.equal(matchesWindow('Сумма (1+1)', 'Сумма (1+1)'), true);
});

test('окно: регулярное выражение в двойных косых', () => {
  assert.equal(matchesWindow('Bank of X', '//bank of//'), true);
  assert.equal(matchesWindow('Другое', '//bank of//'), false);
  assert.equal(matchesWindow('что угодно', '//[//'), false, 'кривая регулярка не совпадает ни с чем');
});

test('окно: пустой шаблон не совпадает ни с чем', () => {
  assert.equal(matchesWindow('GitHub', ''), false);
  assert.equal(matchesWindow('GitHub', '   '), false);
  assert.equal(matchesWindow('', '*'), true);
});

test('адрес: имя узла без www', () => {
  assert.equal(hostOf('https://www.github.com/login'), 'github.com');
  assert.equal(hostOf('github.com'), 'github.com');
  assert.equal(hostOf('  https://Sub.Example.CO.uk/a?b '), 'sub.example.co.uk');
});

test('адрес: не всякая строка — адрес', () => {
  // Any word at all parses as a host name; a Russian one comes back as
  // punycode and would then be "found" in window titles at random.
  assert.equal(hostOf('нет'), null);
  assert.equal(hostOf('заметка про банк'), null);
  assert.equal(hostOf(''), null);
  assert.equal(hostOf(null), null);
});

const gh = {
  title: 'GitHub',
  url: 'https://github.com/login',
  autoType: { items: [{ window: '*GitHub*', sequence: '{USERNAME}{TAB}{PASSWORD}' }] },
};

test('подбор: своя настройка окна важнее догадок', () => {
  const hit = scoreForWindow(gh, 'GitHub — Google Chrome');
  assert.ok(hit.score >= 100);
  assert.equal(hit.sequence, '{USERNAME}{TAB}{PASSWORD}', 'вместе с записанной последовательностью');
});

test('подбор: из двух настроек выигрывает подробная', () => {
  const entry = {
    title: 'Почта',
    autoType: {
      items: [
        { window: '*Chrome*', sequence: 'общая' },
        { window: '*Почта — Chrome*', sequence: 'точная' },
      ],
    },
  };
  assert.equal(scoreForWindow(entry, 'Почта — Chrome').sequence, 'точная');
});

test('подбор: без настроек — по адресу и названию', () => {
  const plain = { title: 'GitHub', url: 'https://github.com/login' };
  assert.equal(scoreForWindow(plain, 'github.com/login — Chrome').why, 'адрес записи в заголовке');
  assert.equal(scoreForWindow(plain, 'GitHub — Chrome').why, 'имя сайта в заголовке');
  assert.equal(scoreForWindow({ title: 'Банк' }, 'Банк — вход').why, 'название записи в заголовке');
});

test('подбор: чужому окну ничего не предлагается', () => {
  assert.equal(scoreForWindow(gh, 'Проводник').score, 0);
  assert.equal(scoreForWindow(gh, '').score, 0);
  // A two-letter title would otherwise match half the desktop.
  assert.equal(scoreForWindow({ title: 'ok' }, 'Документ ok.txt — Блокнот').score, 0);
  assert.deepEqual(forWindow([gh, { title: 'ok' }], 'Проводник'), []);
});

test('подбор: список идёт от самого подходящего', () => {
  const list = forWindow([{ title: 'GitHub' }, gh], 'GitHub — Google Chrome');
  assert.equal(list.length, 2);
  assert.equal(list[0].why, 'окно из настроек записи');
});

const shelf = [
  { title: 'GitHub', user: 'gus', url: 'https://github.com', group: 'Работа', tags: ['код'], notes: '' },
  { title: 'GitLab', user: 'gus@example.com', url: 'https://gitlab.com', group: 'Работа', tags: [], notes: '' },
  { title: 'Банк', user: 'ivan', url: 'https://bank.ru', group: 'Деньги', tags: [], notes: 'зарплатная карта' },
  { title: 'Ёлка', user: '', url: '', group: 'Дом', tags: [], notes: '' },
];

test('поиск: по началу названия — первым', () => {
  assert.equal(search(shelf, 'git')[0].title, 'GitHub');
  assert.equal(search(shelf, 'git').length, 2);
});

test('поиск: по логину, адресу, группе и заметке', () => {
  assert.equal(search(shelf, 'example.com')[0].title, 'GitLab');
  assert.equal(search(shelf, 'деньги')[0].title, 'Банк');
  assert.equal(search(shelf, 'зарплатная')[0].title, 'Банк');
  assert.equal(search(shelf, 'код')[0].title, 'GitHub');
});

test('поиск: второе слово сужает, а не расширяет', () => {
  assert.equal(search(shelf, 'работа gus').length, 2);
  assert.equal(search(shelf, 'работа ivan').length, 0);
});

test('поиск: ё и Е — одна буква, регистр не важен', () => {
  assert.equal(search(shelf, 'елка')[0].title, 'Ёлка');
  assert.equal(search(shelf, 'ЁЛКА')[0].title, 'Ёлка');
});

test('поиск: пустой запрос отдаёт всё, но не больше предела', () => {
  assert.equal(search(shelf, '').length, 4);
  assert.equal(search(shelf, '   ').length, 4);
  assert.equal(search(shelf, '', 2).length, 2);
});

test('поиск: чего нет, того нет', () => {
  assert.deepEqual(search(shelf, 'такого точно нет'), []);
  assert.deepEqual(search([], 'git'), []);
});
