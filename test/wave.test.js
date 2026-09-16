'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { YandexMusic } = require('../src/main/yandex');

/** A client that answers from a script instead of the network. */
function stubbed(answers) {
  const ya = new YandexMusic();
  ya.token = 'test';
  ya.uid = '1';
  ya.calls = [];
  ya._text = async (url) => {
    ya.calls.push({ path: url, method: 'TEXT' });
    const answer = answers[url];
    return typeof answer === 'function' ? answer() : answer || '';
  };
  ya._req = async (path, opts = {}) => {
    ya.calls.push({ path, method: opts.method || 'GET', query: opts.query, json: opts.json });
    const answer = answers[path];
    if (answer === undefined) return {};
    return typeof answer === 'function' ? answer() : answer;
  };
  return ya;
}

const rotorTrack = (id, title, durationMs = 180000) => ({
  track: {
    id,
    title,
    durationMs,
    artists: [{ name: 'Исполнитель' }],
    albums: [{ id: id * 10, coverUri: 'avatars.yandex.net/x/%%' }],
  },
});

const batch = (...tracks) => ({ result: { batchId: 'b1', sequence: tracks } });

test('волна: первый трек приходит с длительностью и обложкой', async () => {
  const ya = stubbed({ '/rotor/station/user:onyourwave/tracks': batch(rotorTrack(1, 'Первый', 95000)) });

  const res = await ya.waveStart();
  assert.equal(res.ok, true);
  assert.deepEqual(
    { id: res.track.id, albumId: res.track.albumId, title: res.track.title, durationMs: res.track.durationMs },
    { id: '1', albumId: '10', title: 'Первый', durationMs: 95000 }
  );
  assert.equal(res.track.duration, '1:35');
  assert.equal(res.track.cover, 'https://avatars.yandex.net/x/200x200');
});

test('волна: очередь выдаётся по одному треку', async () => {
  const ya = stubbed({
    '/rotor/station/user:onyourwave/tracks': batch(rotorTrack(1, 'Первый'), rotorTrack(2, 'Второй')),
  });

  assert.equal((await ya.waveStart()).track.title, 'Первый');
  assert.equal((await ya.waveNext('1', 180)).track.title, 'Второй');
});

test('волна: пустая очередь просит следующую порцию', async () => {
  let served = 0;
  const ya = stubbed({
    '/rotor/station/user:onyourwave/tracks': () => {
      served++;
      return batch(rotorTrack(served, `Порция ${served}`));
    },
  });

  await ya.waveStart();
  const next = await ya.waveNext('1', 180);
  assert.equal(next.track.title, 'Порция 2');
  assert.equal(served, 2, 'за новой порцией сходили ровно один раз');
});

test('волна: станции сообщают о начале и конце трека', async () => {
  const ya = stubbed({ '/rotor/station/user:onyourwave/tracks': batch(rotorTrack(1, 'Первый')) });

  await ya.waveStart();
  await ya.waveNext('1', 42.4);

  const feedback = ya.calls.filter((c) => c.path.endsWith('/feedback')).map((c) => c.json.type);
  assert.deepEqual(feedback.slice(0, 3), ['radioStarted', 'trackStarted', 'trackFinished']);

  const finished = ya.calls.find((c) => c.json && c.json.type === 'trackFinished');
  assert.equal(finished.json.totalPlayedSeconds, 42, 'секунды округляются, а не уходят дробью');
  assert.equal(finished.method, 'POST');
});

test('волна: трек без альбома пропускается — играть его нечем', async () => {
  const broken = { track: { id: 7, title: 'Без альбома', artists: [], albums: [] } };
  const ya = stubbed({
    '/rotor/station/user:onyourwave/tracks': batch(broken, rotorTrack(8, 'Годный')),
  });

  assert.equal((await ya.waveStart()).track.title, 'Годный');
});

test('волна: пустой ответ станции не выдаётся за трек', async () => {
  const ya = stubbed({ '/rotor/station/user:onyourwave/tracks': { result: { sequence: [] } } });
  const res = await ya.waveStart();
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('волна: без подключённого аккаунта не запускается', async () => {
  const ya = new YandexMusic();
  const res = await ya.waveStart();
  assert.equal(res.ok, false);
  assert.match(res.error, /аккаунт/i);
});

test('волна: сбой сети возвращает ошибку, а не падение', async () => {
  const ya = stubbed({});
  ya._req = async () => {
    throw new Error('Нет связи');
  };
  const res = await ya.waveStart();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Нет связи');
});

// ── search results feed the same player, so they need the same fields ───────
test('поиск: результат несёт всё нужное для воспроизведения', async () => {
  const ya = stubbed({
    '/search': {
      result: {
        tracks: {
          results: [
            {
              id: 5,
              title: 'Название',
              version: 'live',
              durationMs: 200000,
              artists: [{ name: 'Кто-то' }],
              albums: [{ id: 50, coverUri: 'avatars.yandex.net/y/%%' }],
            },
          ],
        },
      },
    },
  });

  const res = await ya.searchTracks('что угодно');
  assert.equal(res.ok, true);
  const t = res.items[0];
  assert.equal(t.title, 'Название (live)');
  assert.equal(t.albumId, '50');
  assert.equal(t.durationMs, 200000, 'без длительности волна не узнает, что трек кончился');
  assert.equal(t.duration, '3:20');
});

// ── ссылка на поток: на ней держится вся независимость виджета ──────────────
const SIGN_XML = `<download-info>
  <host>s1.storage.yandex.net</host>
  <path>/get-mp3/x/y/track.mp3</path>
  <ts>1a08a514b0d</ts>
  <s>c0ffee</s>
</download-info>`;

const downloadInfo = (...variants) => ({ result: variants });

test('поток: подписанная ссылка собирается за два запроса', async () => {
  const ya = stubbed({
    '/tracks/42/download-info': downloadInfo(
      { codec: 'mp3', bitrateInKbps: 192, downloadInfoUrl: 'https://sign/192' },
      { codec: 'mp3', bitrateInKbps: 320, downloadInfoUrl: 'https://sign/320' }
    ),
    'https://sign/320': SIGN_XML,
  });

  const res = await ya.streamUrl('42');
  assert.equal(res.ok, true);
  assert.equal(res.bitrate, 320, 'качество не режем');
  assert.equal(res.preview, false);
  assert.match(res.url, /^https:\/\/s1\.storage\.yandex\.net\/get-mp3\/[0-9a-f]{32}\/1a08a514b0d\/get-mp3\/x\/y\/track\.mp3$/);
  assert.ok(
    ya.calls.some((c) => c.path === 'https://sign/320'),
    'за подписью ходили именно к лучшему варианту'
  );
});

test('поток: превью честно помечается', async () => {
  const ya = stubbed({
    '/tracks/42/download-info': downloadInfo({
      codec: 'mp3',
      bitrateInKbps: 128,
      preview: true,
      downloadInfoUrl: 'https://sign/p',
    }),
    'https://sign/p': SIGN_XML,
  });

  assert.equal((await ya.streamUrl('42')).preview, true);
});

test('поток: трек, который нечем играть, не выдаётся за годный', async () => {
  const ya = stubbed({ '/tracks/42/download-info': downloadInfo() });
  const res = await ya.streamUrl('42');
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('поток: обрезанная подпись не превращается в битую ссылку', async () => {
  const ya = stubbed({
    '/tracks/42/download-info': downloadInfo({ codec: 'mp3', bitrateInKbps: 320, downloadInfoUrl: 'https://sign/x' }),
    'https://sign/x': '<download-info><host>s1</host></download-info>',
  });

  const res = await ya.streamUrl('42');
  assert.equal(res.ok, false);
  assert.match(res.error, /подпис/i);
});

test('поток: сбой сети возвращает ошибку, а не падение', async () => {
  const ya = stubbed({});
  ya._req = async () => {
    throw new Error('Нет связи');
  };
  const res = await ya.streamUrl('42');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Нет связи');
});

test('поток: чужой id до сети не доходит', async () => {
  const ya = stubbed({});
  for (const bad of ['', null, 'abc', '1; drop', '../7']) {
    const res = await ya.streamUrl(bad);
    assert.equal(res.ok, false, `${bad} не должен считаться треком`);
  }
  assert.equal(ya.calls.length, 0, 'ни одного запроса за мусорный id');
});

test('поток: без подключённого аккаунта ссылку не просят', async () => {
  const res = await new YandexMusic().streamUrl('42');
  assert.equal(res.ok, false);
  assert.match(res.error, /аккаунт/i);
});

// ── титры: их добывают тем же путём, что и звук ─────────────────────────────
const LRC = '[ar: Кто-то]\n[00:01.55] Первая\n[00:18.97] Вторая\n';

test('титры: приходят разобранными на строки со временем', async () => {
  const ya = stubbed({
    '/tracks/42/lyrics': { result: { downloadUrl: 'https://lyrics/42' } },
    'https://lyrics/42': LRC,
  });

  const res = await ya.lyricsFor('42');
  assert.equal(res.ok, true);
  assert.deepEqual(res.lines, [
    { at: 1.55, text: 'Первая' },
    { at: 18.97, text: 'Вторая' },
  ]);

  const call = ya.calls.find((c) => c.path === '/tracks/42/lyrics');
  assert.equal(call.query.format, 'LRC', 'простыня без времени панели не нужна');
  assert.ok(call.query.sign, 'без подписи Яндекс отвечает 403');
  assert.ok(call.query.timeStamp);
});

test('титры: подпись считается от номера трека и метки времени', async () => {
  const crypto = require('crypto');
  const ya = stubbed({ '/tracks/42/lyrics': { result: { downloadUrl: 'https://lyrics/42' } }, 'https://lyrics/42': LRC });
  await ya.lyricsFor('42');

  const { query } = ya.calls.find((c) => c.path === '/tracks/42/lyrics');
  const expected = crypto.createHmac('sha256', 'p93jhgh689SBReK6ghtw62').update(`42${query.timeStamp}`).digest('base64');
  assert.equal(query.sign, expected);
});

test('титры: за файлом текста идут без токена', async () => {
  const ya = stubbed({ '/tracks/42/lyrics': { result: { downloadUrl: 'https://lyrics/42' } }, 'https://lyrics/42': LRC });
  const seen = [];
  const inner = ya._text;
  ya._text = async (url, opts) => {
    seen.push(opts);
    return inner(url, opts);
  };

  await ya.lyricsFor('42');
  assert.deepEqual(seen[0], { auth: false }, 'хранилище текстов токена не ждёт и не любит');
});

test('титры: второй раз тот же трек по сети не гоняют', async () => {
  const ya = stubbed({ '/tracks/42/lyrics': { result: { downloadUrl: 'https://lyrics/42' } }, 'https://lyrics/42': LRC });
  await ya.lyricsFor('42');
  const after = ya.calls.length;
  const again = await ya.lyricsFor('42');

  assert.equal(again.ok, true);
  assert.equal(ya.calls.length, after, 'повтор трека не должен стоить двух запросов');
});

test('титры: «текста нет» тоже запоминается', async () => {
  const ya = stubbed({ '/tracks/42/lyrics': { result: {} } });
  assert.equal((await ya.lyricsFor('42')).ok, false);
  const after = ya.calls.length;

  const again = await ya.lyricsFor('42');
  assert.equal(again.ok, false);
  assert.equal(ya.calls.length, after, 'ходить второй раз за тем же «ничего» незачем');
});

test('титры: сбой сети не выдают за отсутствие текста', async () => {
  let fail = true;
  const ya = stubbed({
    '/tracks/42/lyrics': () => {
      if (fail) throw new Error('Нет связи');
      return { result: { downloadUrl: 'https://lyrics/42' } };
    },
    'https://lyrics/42': LRC,
  });

  assert.equal((await ya.lyricsFor('42')).error, 'Нет связи');
  fail = false;
  assert.equal((await ya.lyricsFor('42')).ok, true, 'иначе один обрыв связи оставил бы трек немым навсегда');
});

test('титры: чужой id до сети не доходит', async () => {
  const ya = stubbed({});
  assert.equal((await ya.lyricsFor('../7')).ok, false);
  assert.equal(ya.calls.length, 0);
});

test('титры: волна отмечает, у каких треков есть синхронный текст', async () => {
  const withWords = rotorTrack(1, 'Со словами');
  withWords.track.lyricsInfo = { hasAvailableSyncLyrics: true, hasAvailableTextLyrics: true };
  const onlyPlain = rotorTrack(2, 'Простыня');
  onlyPlain.track.lyricsInfo = { hasAvailableSyncLyrics: false, hasAvailableTextLyrics: true };

  const ya = stubbed({ '/rotor/station/user:onyourwave/tracks': batch(withWords, onlyPlain) });
  assert.equal((await ya.waveStart()).track.lyrics, true);
  assert.equal((await ya.waveNext('1', 1)).track.lyrics, false, 'текст без времени за титры не считается');
});

test('титры: отказ «нет текста» переводится и запоминается', async () => {
  let asked = 0;
  const ya = stubbed({
    '/tracks/42/lyrics': () => {
      asked += 1;
      throw new Error('No lyrics found for track');
    },
  });

  const res = await ya.lyricsFor('42');
  assert.equal(res.error, 'У этого трека нет текста', 'ответ Яндекса по-английски в панель не пускаем');
  await ya.lyricsFor('42');
  assert.equal(asked, 1, 'это ответ, а не сбой — спрашивать снова незачем');
});

// ── the heart for the widget's own player ───────────────────────────────────
test('лайк: у своего плеера сердечко по точному номеру трека, без поиска', async () => {
  const ya = stubbed({});
  ya.liked.add('777');
  ya.likesAt = Date.now();
  ya.pinTrack({ id: '777', albumId: '70', title: 'Топоры', artists: 'PALC' });
  assert.equal(ya.current.id, '777');
  assert.equal(ya.current.liked, true, 'пролайканный трек сразу с полным сердечком');
  assert.ok(!ya.calls.some((c) => c.path === '/search'), 'в поиск не ходили');
});

test('лайк: эхо медиасессии своего плеера не подменяет точный трек догадкой', async () => {
  const ya = stubbed({ '/search': { result: { tracks: { results: [{ id: 1, title: 'Топоры', artists: [{ name: 'PALC' }], albums: [{ id: 2 }] }] } } } });
  ya.likesAt = Date.now();
  ya.pinTrack({ id: '777', albumId: '70', title: 'Топоры', artists: 'PALC' });
  await ya.onTrack('PALC|Топоры', 'PALC', 'Топоры');
  assert.equal(ya.current.id, '777', 'остался точный номер, а не первый результат поиска');

  ya.pinTrack(null);
  await ya.onTrack('Другой|Трек', 'Другой', 'Трек');
  assert.notEqual(ya.current.key, 'own|777', 'без своего плеера треки снова ищутся как раньше');
});
