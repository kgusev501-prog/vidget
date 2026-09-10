'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { pickVariant, parseSignature, buildStreamUrl, SALT } = require('../src/shared/stream-url');

const variant = (bitrateInKbps, extra = {}) => ({ codec: 'mp3', bitrateInKbps, ...extra });

test('поток: берётся самый высокий битрейт', () => {
  const best = pickVariant([variant(64), variant(320), variant(192)]);
  assert.equal(best.bitrateInKbps, 320);
});

test('поток: превью проигрывает полному треку любого битрейта', () => {
  const best = pickVariant([variant(320, { preview: true }), variant(128)]);
  assert.equal(best.bitrateInKbps, 128, 'тридцать секунд — это не трек');
  assert.equal(best.preview, undefined);
});

test('поток: если полного нет, превью всё же лучше тишины', () => {
  const best = pickVariant([variant(192, { preview: true })]);
  assert.equal(best.preview, true);
});

test('поток: чужой кодек не берут', () => {
  assert.equal(pickVariant([{ codec: 'aac', bitrateInKbps: 256 }]), null);
  assert.equal(pickVariant([]), null);
  assert.equal(pickVariant(null), null);
});

const XML = `<?xml version="1.0" encoding="utf-8"?>
<download-info>
  <host>s42vla.storage.yandex.net</host>
  <path>/get-mp3/deadbeef/1a2b3c/music/1.mp3</path>
  <ts>1a08a514b0d</ts>
  <region>225</region>
  <s>c0ffee1234</s>
</download-info>`;

test('подпись: из ответа достаются все четыре поля', () => {
  assert.deepEqual(parseSignature(XML), {
    host: 's42vla.storage.yandex.net',
    path: '/get-mp3/deadbeef/1a2b3c/music/1.mp3',
    ts: '1a08a514b0d',
    s: 'c0ffee1234',
  });
});

test('подпись: неполный ответ не выдаётся за годный', () => {
  assert.equal(parseSignature('<download-info><host>h</host></download-info>'), null);
  assert.equal(parseSignature(''), null);
  assert.equal(parseSignature(null), null);
});

test('ссылка: собирается по правилу клиента Яндекса', () => {
  const sig = parseSignature(XML);
  const url = buildStreamUrl(sig);

  const expected = crypto.createHash('md5').update(SALT + sig.path.slice(1) + sig.s).digest('hex');
  assert.equal(url, `https://${sig.host}/get-mp3/${expected}/${sig.ts}${sig.path}`);
  assert.ok(url.startsWith('https://'), 'звук идёт только по https');
});

test('ссылка: ведущий слэш пути в подпись не входит', () => {
  const sig = { host: 'h', path: '/a/b.mp3', ts: 't', s: 'salted' };
  const withSlash = crypto.createHash('md5').update(SALT + sig.path + sig.s).digest('hex');
  assert.ok(!buildStreamUrl(sig).includes(withSlash), 'иначе хост отдаст 403');
});

test('ссылка: без подписи её не построить', () => {
  assert.equal(buildStreamUrl(null), null);
});
