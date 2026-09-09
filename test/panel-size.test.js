'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { panelSize, slotX, slotFraction, MAX_W, MIN_W, MAX_SHADE, MIN_SHADE } = require('../src/shared/panel-size');

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

// ── where the strip sits along the top edge ─────────────────────────────────
// The position is dragged in screen coordinates but kept as a share of the room
// the panel has to move in, so unplugging a monitor or changing its scale
// cannot leave the widget parked somewhere off the screen.

test('положение: без запомненного места панель посередине', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const { width } = panelSize(area);
  assert.equal(slotX(area, width, undefined), Math.round((1920 - width) / 2));
  assert.equal(slotX(area, width, null), Math.round((1920 - width) / 2));
});

test('положение: края — это края, дальше не уедет', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const { width } = panelSize(area);
  assert.equal(slotX(area, width, 0), 0);
  assert.equal(slotX(area, width, 1), 1920 - width);
  assert.equal(slotX(area, width, -3), 0, 'мусор слева прижимается к левому краю');
  assert.equal(slotX(area, width, 9), 1920 - width, 'и справа к правому');
});

test('положение: соседний монитор считается от своего начала', () => {
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };
  const { width } = panelSize(second);
  assert.equal(slotX(second, width, 0), 1920, 'левый край второго экрана, а не первого');
  assert.equal(slotX(second, width, 1), 1920 + 2560 - width);
});

test('положение: доля и координата переводятся друг в друга', () => {
  const area = { x: -1440, y: 0, width: 1440, height: 900 };
  const { width } = panelSize(area);
  for (const share of [0, 0.25, 0.5, 0.75, 1]) {
    const x = slotX(area, width, share);
    assert.ok(Math.abs(slotFraction(area, width, x) - share) < 0.01, `доля ${share} возвращается собой`);
  }
});

test('положение: точка вне экрана превращается в его край', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const { width } = panelSize(area);
  assert.equal(slotFraction(area, width, -5000), 0);
  assert.equal(slotFraction(area, width, 99999), 1);
});

test('положение: на узком экране двигаться некуда', () => {
  // The panel is as wide as the work area, or wider: every position is the same
  // position, and dividing by the room left would divide by zero.
  const area = { x: 0, y: 0, width: 500, height: 900 };
  const { width } = panelSize(area);
  assert.ok(width >= 500);
  assert.equal(slotX(area, width, 0.8), 0);
  assert.equal(slotFraction(area, width, 320), 0.5);
});
