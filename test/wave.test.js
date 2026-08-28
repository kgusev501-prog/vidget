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
