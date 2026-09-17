'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dock = require('../src/shared/dock');

const FHD = { x: 0, y: 0, width: 1920, height: 1040 }; // taskbar below
const inside = (r, area) =>
  r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;

test('место: старая запись x читается как доля вдоль верхнего края', () => {
  assert.deepEqual(dock.normalizePlacement({ display: 5, x: 0.25 }), { display: 5, edge: 'top', along: 0.25 });
  assert.deepEqual(dock.normalizePlacement(null), { display: null, edge: 'top', along: 0.5 });
  assert.deepEqual(dock.normalizePlacement({ edge: 'diagonal', along: 7 }), { display: null, edge: 'top', along: 1 });
});

test('верх: челка доходит до самых углов, а окно остаётся в экране', () => {
  for (const along of [0, 1]) {
    const l = dock.dockLayout(FHD, { edge: 'top', along });
    const centre = l.bounds.x + l.handle.x;
    const expected = along === 0 ? dock.HANDLE_LEN / 2 : 1920 - dock.HANDLE_LEN / 2;
    assert.equal(centre, expected, `центр челки у ${along === 0 ? 'левого' : 'правого'} угла`);
    assert.ok(inside(l.bounds, FHD), 'окно не вылезает за экран');
  }
});

test('верх: посередине всё как было', () => {
  const l = dock.dockLayout(FHD, { edge: 'top', along: 0.5 });
  assert.equal(l.bounds.x, Math.round((1920 - l.bounds.width) / 2));
  assert.equal(l.bounds.y, 0);
  assert.equal(l.handle.x, l.bounds.width / 2);
});

test('низ: окно стоит над панелью задач и панель выезжает вверх', () => {
  const l = dock.dockLayout(FHD, { edge: 'bottom', along: 0.5 });
  assert.equal(l.bounds.y + l.bounds.height, 1040, 'нижняя кромка окна — верх панели задач');
  assert.equal(l.handle.y, l.bounds.height);
  assert.equal(l.panel.y + l.panel.height, l.bounds.height, 'панель прижата к нижнему краю окна');
});

test('бока: окно у края, панель на высоте челки, но в пределах окна', () => {
  for (const edge of ['left', 'right']) {
    for (const along of [0, 0.5, 1]) {
      const l = dock.dockLayout(FHD, { edge, along });
      assert.ok(inside(l.bounds, FHD), `${edge} ${along}: окно в экране`);
      assert.equal(edge === 'left' ? l.bounds.x : l.bounds.x + l.bounds.width, edge === 'left' ? 0 : 1920);
      assert.ok(l.panel.y >= 0 && l.panel.y + l.panel.height <= l.bounds.height, 'панель в окне');
      assert.ok(l.bounds.height >= l.karaoke.height, 'плита караоке помещается в окно');
      assert.equal(l.panel.width, dock.KARAOKE_W, 'сбоку панель узкая, как экран телефона');
      assert.equal(l.panel.height, l.karaoke.height, 'и той же высоты, что плита караоке');
      assert.ok(l.bounds.width < 600, 'окно не шире, чем нужно телефону и его тени');
      const centre = l.bounds.y + l.handle.y;
      if (along === 0) assert.equal(centre, dock.HANDLE_LEN / 2);
      if (along === 1) assert.equal(centre, 1040 - dock.HANDLE_LEN / 2);
    }
  }
});

test('ближайший край: курсор решает, куда перейдёт челка', () => {
  assert.equal(dock.nearestEdge(FHD, { x: 900, y: 3 }), 'top');
  assert.equal(dock.nearestEdge(FHD, { x: 900, y: 1030 }), 'bottom');
  assert.equal(dock.nearestEdge(FHD, { x: 4, y: 500 }), 'left');
  assert.equal(dock.nearestEdge(FHD, { x: 1915, y: 500 }), 'right');
  assert.equal(dock.nearestEdge(FHD, { x: 10, y: 10 }), 'top', 'поровну — остаётся верх');
});

test('перенос: доля вдоль края возвращается собой', () => {
  for (const edge of dock.EDGES) {
    for (const along of [0, 0.3, 0.77, 1]) {
      const c = dock.centreAlong(FHD, edge, along);
      assert.ok(Math.abs(dock.alongFor(FHD, edge, c) - along) < 0.002, `${edge} ${along}`);
    }
  }
});

test('перенос: смещение хвата учитывается, пока край тот же', () => {
  const p = dock.placeAt(FHD, { x: 600, y: 2 }, 100);
  assert.equal(p.edge, 'top');
  assert.equal(dock.centreAlong(FHD, 'top', p.along), 500);
});

test('второй монитор: всё считается от его рабочей области', () => {
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };
  const l = dock.dockLayout(second, { edge: 'right', along: 0.5 });
  assert.ok(inside(l.bounds, second));
  assert.equal(l.bounds.x + l.bounds.width, 1920 + 2560);
});

test('зона захвата по умолчанию лежит у края', () => {
  const top = dock.defaultGrab(dock.dockLayout(FHD, { edge: 'top', along: 0 }));
  assert.deepEqual(top, { x: 0, y: 0, width: dock.HANDLE_LEN, height: dock.HANDLE_DEPTH });
  const left = dock.defaultGrab(dock.dockLayout(FHD, { edge: 'left', along: 0.5 }));
  assert.equal(left.x, 0);
  assert.equal(left.width, dock.HANDLE_DEPTH);
  assert.equal(left.y + left.height / 2, 520);
});

test('низкий экран: плита караоке ужимается, а не вылезает', () => {
  const short = { x: 0, y: 0, width: 1366, height: 700 };
  const l = dock.dockLayout(short, { edge: 'left', along: 0.5 });
  assert.ok(l.karaoke.height <= 700 - 48);
  assert.ok(inside(l.bounds, short));
});

test('тень: у панели есть место рассеяться со всех сторон, что не прижаты к краю экрана', () => {
  for (const edge of ['top', 'bottom']) {
    const l = dock.dockLayout(FHD, { edge, along: 0.5 });
    assert.ok(l.panel.x >= dock.SHADOW, `${edge}: слева от панели есть место`);
    assert.ok(l.bounds.width - l.panel.x - l.panel.width >= dock.SHADOW, `${edge}: и справа`);
    assert.ok(inside(l.bounds, FHD));
  }
  for (const edge of ['left', 'right']) {
    for (const along of [0, 0.5, 1]) {
      const l = dock.dockLayout(FHD, { edge, along });
      assert.ok(l.panel.y >= dock.SHADOW, `${edge} ${along}: над панелью`);
      assert.ok(l.bounds.height - l.panel.y - l.panel.height >= dock.SHADOW, `${edge} ${along}: под панелью`);
    }
  }
  const narrow = { x: 0, y: 0, width: 600, height: 700 };
  const n = dock.dockLayout(narrow, { edge: 'top', along: 0.5 });
  assert.ok(inside(n.bounds, narrow), 'на узком экране окно не шире экрана');
  assert.ok(n.panel.x + n.panel.width <= n.bounds.width, 'и панель в окне');
});
