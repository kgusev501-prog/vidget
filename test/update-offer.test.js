'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { describe, shouldOffer } = require('../src/shared/update-offer');

test('обновление: найденная версия предлагается', () => {
  assert.equal(shouldOffer({ status: 'available', version: '0.2.6' }, ''), true);
  assert.equal(describe({ status: 'available', version: '0.2.6' }), 'доступна версия 0.2.6');
});

test('обновление: пропущенная версия молчит, а следующая снова предлагается', () => {
  assert.equal(shouldOffer({ status: 'available', version: '0.2.6' }, '0.2.6'), false);
  assert.equal(shouldOffer({ status: 'available', version: '0.2.7' }, '0.2.6'), true);
});

test('обновление: закрытое крестиком молчит до следующего запуска', () => {
  assert.equal(shouldOffer({ status: 'available', version: '0.2.6' }, '', true), false);
});

test('обновление: проверка из настроек показывает ответ даже для пропущенной', () => {
  assert.equal(shouldOffer({ status: 'available', version: '0.2.6', manual: true }, '0.2.6', true), true);
});

test('обновление: начатое пользователем видно до конца, ошибка — только ему', () => {
  for (const status of ['downloading', 'ready', 'installing']) {
    assert.equal(shouldOffer({ status, version: '0.2.6' }, '0.2.6', true), true, status);
  }
  assert.equal(shouldOffer({ status: 'error', version: '0.2.6', userStarted: true }, ''), true);
  assert.equal(shouldOffer({ status: 'error', error: 'нет связи с GitHub' }, ''), false, 'тихая проверка без связи не шумит');
});

test('обновление: ничего нового — ничего не показываем', () => {
  for (const status of ['idle', 'checking', 'none']) assert.equal(shouldOffer({ status }, ''), false);
  assert.equal(describe({ status: 'downloading', version: '0.2.6', percent: 42.4 }), 'загружаем 0.2.6 — 42 %');
  assert.equal(describe({ status: 'error', error: 'нет связи с GitHub' }), 'нет связи с GitHub');
});
