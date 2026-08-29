'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { panelSize, MAX_W, MIN_W, MAX_SHADE, MIN_SHADE } = require('../src/shared/panel-size');

test('размер панели: широкий монитор — полная ширина', () => {
  const s = panelSize({ width: 3440, height: 1400 });
  assert.equal(s.width, MAX_W);
  assert.equal(s.shade, MAX_SHADE);
});

test('размер панели: обычный ноутбук 1920×1080', () => {
  const s = panelSize({ width: 1920, height: 1040 });
  assert.equal(s.width, MAX_W, 'места хватает');
  assert.equal(s.shade, MAX_SHADE);
});

test('размер панели: 1920 при масштабе 150% — работа идёт в 1280 точках', () => {
  const s = panelSize({ width: 1280, height: 660 });
  assert.equal(s.width, MAX_W, '1280 − 80 всё ещё больше максимума');
  assert.equal(s.shade, MAX_SHADE);
});

test('размер панели: узкий экран ужимается, но не до нуля', () => {
  const s = panelSize({ width: 1024, height: 700 });
  assert.equal(s.width, 944, 'по краям остаётся отступ');
  assert.ok(s.width < MAX_W);
});

test('размер панели: очень узкий экран упирается в минимум', () => {
  const s = panelSize({ width: 600, height: 700 });
  assert.equal(s.width, MIN_W, 'уже некуда — держим читаемую ширину');
});

test('размер панели: низкий экран укорачивает шторку', () => {
  const s = panelSize({ width: 1600, height: 380 });
  assert.equal(s.shade, 260);
  assert.ok(s.height <= 380, 'окно не выше рабочей области');
});

test('размер панели: очень низкий экран упирается в минимум шторки', () => {
  const s = panelSize({ width: 1600, height: 260 });
  assert.equal(s.shade, MIN_SHADE);
  assert.ok(s.height <= 278);
});

test('размер панели: окно всегда вмещает шторку', () => {
  for (const height of [200, 260, 340, 500, 800, 1400]) {
    const s = panelSize({ width: 1600, height });
    assert.ok(s.height >= s.shade, `при высоте ${height} окно не обрезает шторку`);
  }
});

test('размер панели: мусор на входе не роняет расчёт', () => {
  for (const area of [undefined, null, {}, { width: 0, height: 0 }, { width: -5, height: -5 }]) {
    const s = panelSize(area);
    assert.equal(s.width, MIN_W);
    assert.equal(s.shade, MIN_SHADE);
    assert.ok(s.height > 0);
  }
});
