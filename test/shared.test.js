'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classify } = require('../src/shared/classify');
const { mmss, coverUrl, norm } = require('../src/shared/format');
const { pickBestTrack } = require('../src/shared/match-track');
const { parseSearch } = require('../src/shared/parse-youtube');

// ── what was copied ─────────────────────────────────────────────────────────
test('classify: ссылки', () => {
  assert.equal(classify('https://music.yandex.ru/home'), 'url');
  assert.equal(classify('www.example.com/x?a=1'), 'url');
  assert.equal(classify('  https://example.com  '), 'url', 'пробелы по краям не мешают');
  assert.equal(classify('смотри https://example.com'), 'text', 'ссылка внутри текста — это текст');
});

test('classify: цвета, почта, пути', () => {
  assert.equal(classify('#fff'), 'color');
  assert.equal(classify('#3D8BFF'), 'color');
  assert.equal(classify('#ff00aa80'), 'color');
  assert.equal(classify('#gg0011'), 'text', 'не шестнадцатеричное — не цвет');

  assert.equal(classify('kgusev501@gmail.com'), 'email');
  assert.equal(classify('C:\\Users\\PComputer\\file.txt'), 'path');
  assert.equal(classify('\\\\server\\share'), 'path');
  assert.equal(classify('C:\\one\nC:\\two'), 'text', 'несколько строк — уже не путь');
});

test('classify: пустое и обычный текст', () => {
  assert.equal(classify(''), 'text');
  assert.equal(classify(null), 'text');
  assert.equal(classify('   '), 'text');
  assert.equal(classify('Идея для проекта'), 'text');
});

// ── formatting ──────────────────────────────────────────────────────────────
test('mmss: длительность трека', () => {
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(9000), '0:09');
  assert.equal(mmss(61000), '1:01');
  assert.equal(mmss(235000), '3:55');
  assert.equal(mmss(undefined), '0:00');
  assert.equal(mmss(-5000), '0:00', 'отрицательное не должно ломать вёрстку');
});

test('coverUrl: подстановка размера', () => {
  assert.equal(coverUrl('avatars.yandex.net/get/1/%%', '200x200'), 'https://avatars.yandex.net/get/1/200x200');
  assert.equal(coverUrl(null, '200x200'), null);
  assert.equal(coverUrl('', '200x200'), null);
});

test('norm: сравнение названий', () => {
  assert.equal(norm('Ёжик, в Тумане!'), 'ежик в тумане');
  assert.equal(norm('  Group   Blood  '), 'group blood');
  assert.equal(norm(null), '');
  assert.equal(norm('Гимн'), norm('гимн'));
});

// ── choosing the right track ────────────────────────────────────────────────
const track = (id, title, ...artists) => ({ id, title, artists: artists.map((name) => ({ name })) });

test('pickBestTrack: точное совпадение выигрывает у кавера', () => {
  const results = [
    track(1, 'Группа крови', 'Кино Фильм'),
    track(2, 'Группа крови', 'КИНО'),
  ];
  assert.equal(pickBestTrack(results, 'КИНО', 'Группа крови').id, 2);
});

test('pickBestTrack: чужой исполнитель отвергается', () => {
  const results = [track(1, 'Группа крови', 'Ленинград')];
  assert.equal(pickBestTrack(results, 'КИНО', 'Группа крови'), null);
});

test('pickBestTrack: совпадение по названию без исполнителя проходит', () => {
  const results = [track(1, 'Группа крови', 'Ленинград')];
  assert.equal(pickBestTrack(results, '', 'Группа крови').id, 1, 'исполнителя не знаем — верим названию');
});

test('pickBestTrack: пустая выдача и мусор', () => {
  assert.equal(pickBestTrack([], 'КИНО', 'Группа крови'), null);
  assert.equal(pickBestTrack(null, 'КИНО', 'Группа крови'), null);
  assert.equal(pickBestTrack([{ title: 'Без id' }], 'КИНО', 'Группа крови'), null);
  assert.equal(pickBestTrack([track(1, 'Что угодно', 'КИНО')], 'КИНО', ''), null, 'без названия выбирать нечего');
});

test('pickBestTrack: смотрит не дальше восьмого результата', () => {
  const filler = Array.from({ length: 8 }, (_, i) => track(i + 1, 'Другое', 'Кто-то'));
  const results = [...filler, track(99, 'Группа крови', 'КИНО')];
  assert.equal(pickBestTrack(results, 'КИНО', 'Группа крови'), null);
});

// ── youtube results page ────────────────────────────────────────────────────
const ytPage = (videos) => {
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: videos } }] },
        },
      },
    },
  };
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
};

const video = (id, title, extra = {}) => ({
  videoRenderer: {
    videoId: id,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: 'Канал' }] },
    lengthText: { simpleText: '3:20' },
    shortViewCountText: { simpleText: '1,2 млн просмотров' },
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' }] },
    ...extra,
  },
});

test('parseSearch: разбирает выдачу', () => {
  const items = parseSearch(ytPage([video('abc12345678', 'Первое'), video('def12345678', 'Второе')]));
  assert.equal(items.length, 2);
  assert.deepEqual(
    { id: items[0].id, title: items[0].title, channel: items[0].channel, duration: items[0].duration },
    { id: 'abc12345678', title: 'Первое', channel: 'Канал', duration: '3:20' }
  );
});

test('parseSearch: пропускает не-видео и помечает эфиры', () => {
  const live = video('liv12345678', 'Эфир', {
    badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }],
  });
  const items = parseSearch(ytPage([{ shelfRenderer: {} }, live, { videoRenderer: { title: 'без id' } }]));
  assert.equal(items.length, 1);
  assert.equal(items[0].live, true);
});

test('parseSearch: не больше двадцати результатов', () => {
  const many = Array.from({ length: 30 }, (_, i) => video(`id${String(i).padStart(9, '0')}`, `Видео ${i}`));
  assert.equal(parseSearch(ytPage(many)).length, 20);
});

test('parseSearch: чужая страница и битый JSON не роняют разбор', () => {
  assert.equal(parseSearch('<html>ничего похожего</html>'), null);
  assert.equal(parseSearch('<script>var ytInitialData = {сломано};</script>'), null);
  assert.equal(parseSearch(''), null);
  assert.equal(parseSearch(null), null);
  assert.deepEqual(parseSearch('<script>var ytInitialData = {"contents":{}};</script>'), []);
});
