'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON store with debounced atomic writes.
 * One file per collection, all under the app's userData folder.
 */
class Store {
  constructor(dir, name, fallback) {
    this.file = path.join(dir, `${name}.json`);
    this.fallback = fallback;
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed == null ? structuredClone(this.fallback) : parsed;
    } catch {
      return structuredClone(this.fallback);
    }
  }

  get() {
    return this.data;
  }

  set(next) {
    this.data = next;
    this.save();
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] write failed', this.file, err.message);
    }
  }
}

module.exports = { Store };
