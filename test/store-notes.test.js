'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/main/store');
const { Notes } = require('../src/main/notes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidget-test-'));

// ── the little JSON store ───────────────────────────────────────────────────
test('Store: пустая папка даёт значения по умолчанию', () => {
  const dir = tmp();
  const store = new Store(dir, 'settings', { autostart: true, tab: 'music' });
  assert.deepEqual(store.get(), { autostart: true, tab: 'music' });
});

test('Store: сохраняет и читает обратно', () => {
  const dir = tmp();
  const first = new Store(dir, 'notes', { notes: [] });
  first.set({ notes: [{ id: 'a', text: 'привет' }] });
  first.flush();

  const second = new Store(dir, 'notes', { notes: [] });
  assert.equal(second.get().notes[0].text, 'привет');
});

test('Store: битый файл не роняет запуск', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'clipboard.json'), '{ это не json', 'utf8');
  const store = new Store(dir, 'clipboard', { items: [] });
  assert.deepEqual(store.get(), { items: [] }, 'подставляются значения по умолчанию');
});

test('Store: значения по умолчанию не делятся между хранилищами', () => {
  const dir = tmp();
  const fallback = { items: [] };
  const a = new Store(dir, 'a', fallback);
  a.get().items.push('испорчено');
  const b = new Store(dir, 'b', fallback);
  assert.deepEqual(b.get().items, [], 'второе хранилище получает свою копию');
});

test('Store: запись не оставляет временный файл', () => {
  const dir = tmp();
  const store = new Store(dir, 'settings', {});
  store.set({ a: 1 });
  store.flush();
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['settings.json'],
    'временный файл переименовывается, а не остаётся рядом'
  );
});

// ── notes ───────────────────────────────────────────────────────────────────
function notes() {
  const store = { data: { notes: [] }, get() { return this.data; }, set(v) { this.data = v; } };
  return new Notes(store);
}

test('Notes: создание даёт ровно одну заметку и один сигнал', () => {
  const n = notes();
  let pushes = 0;
  n.on('change', () => pushes++);

  n.create('одна заметка');
  assert.equal(n.all().length, 1);
  assert.equal(pushes, 1, 'интерфейс не должен добавлять копию сам');
});

test('Notes: заголовок берётся из первой непустой строки', () => {
  const n = notes();
  const note = n.create('\n\n  Заголовок  \nвторая строка');
  assert.equal(note.title, 'Заголовок');
});

test('Notes: правка меняет текст и время', async () => {
  const n = notes();
  const note = n.create('старое');
  await new Promise((r) => setTimeout(r, 5));
  const updated = n.update(note.id, 'новое');
  assert.equal(updated.text, 'новое');
  assert.ok(updated.updated >= note.updated);
  assert.equal(n.all().length, 1, 'правка не создаёт вторую заметку');
});

test('Notes: закреплённые всегда сверху', () => {
  const n = notes();
  const first = n.create('первая');
  n.create('вторая');
  n.togglePin(first.id);

  const order = n.all().map((x) => x.text);
  assert.equal(order[0], 'первая');
});

test('Notes: незакреплённые идут от свежих к старым', async () => {
  const n = notes();
  n.create('старая');
  await new Promise((r) => setTimeout(r, 5));
  n.create('свежая');
  assert.equal(n.all()[0].text, 'свежая');
});

test('Notes: удаление убирает только одну', () => {
  const n = notes();
  const a = n.create('а');
  n.create('б');
  n.remove(a.id);
  assert.deepEqual(n.all().map((x) => x.text), ['б']);
});

test('Notes: правка несуществующей ничего не портит', () => {
  const n = notes();
  n.create('одна');
  assert.equal(n.update('нет-такой', 'текст'), null);
  assert.equal(n.all().length, 1);
});
