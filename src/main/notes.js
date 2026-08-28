'use strict';

const { EventEmitter } = require('events');

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const titleOf = (text) => {
  const line = (text || '').split('\n').find((l) => l.trim());
  return (line || '').trim().slice(0, 80);
};

/** Flat list of quick notes, newest-edited first, pinned on top. */
class Notes extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
  }

  get list() {
    return this.store.get().notes || [];
  }

  set list(next) {
    this.store.set({ notes: next });
    this.emit('change', next);
  }

  all() {
    return [...this.list].sort((a, b) => b.pinned - a.pinned || b.updated - a.updated);
  }

  create(text = '') {
    const note = { id: newId(), text, title: titleOf(text), created: Date.now(), updated: Date.now(), pinned: false };
    this.list = [note, ...this.list];
    return note;
  }

  update(id, text) {
    let hit = null;
    this.list = this.list.map((n) => {
      if (n.id !== id) return n;
      hit = { ...n, text, title: titleOf(text), updated: Date.now() };
      return hit;
    });
    return hit;
  }

  remove(id) {
    this.list = this.list.filter((n) => n.id !== id);
  }

  togglePin(id) {
    this.list = this.list.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n));
  }
}

module.exports = { Notes };
