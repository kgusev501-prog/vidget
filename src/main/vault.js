'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const kdbxweb = require('kdbxweb');
const { argon2d, argon2id } = require('hash-wasm');

const totp = require('../shared/totp');
const { parse: parseSequence, DEFAULT_SEQUENCE } = require('../shared/autotype-sequence');
const { forWindow, search } = require('../shared/entry-match');

/**
 * The KeePass database, read.
 *
 * The file stays where the user keeps it and is never written to: KeePass and
 * KeePassXC remain the place entries are edited, and a bug here cannot cost
 * anybody their passwords. Everything below runs in the main process — the
 * panel is told titles and user names, and is handed one secret at a time, only
 * when someone asks for it.
 */

// kdbxweb hands Argon2 its memory in kibibytes already, and names the variant
// by the number from the Argon2 spec rather than by the KDBX uuid.
let argonReady = false;
function useArgon2() {
  if (argonReady) return;
  argonReady = true;
  kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
    const hash = await (type === 2 ? argon2id : argon2d)({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      parallelism,
      iterations,
      memorySize: memory,
      hashLength: length,
      outputType: 'binary',
    });
    return hash.buffer;
  });
}

const DEFAULT_LOCK_MS = 10 * 60 * 1000;

/** kdbxweb speaks in error codes; a person needs a sentence. */
function explain(err) {
  const code = err && err.code;
  if (code === kdbxweb.Consts.ErrorCodes.InvalidKey) return 'Неверный пароль или файл-ключ';
  if (code === kdbxweb.Consts.ErrorCodes.FileCorrupt) return 'Файл повреждён или это не база KeePass';
  if (code === kdbxweb.Consts.ErrorCodes.Unsupported) return `База использует то, что мы не умеем: ${err.message}`;
  if (code === kdbxweb.Consts.ErrorCodes.NotImplemented) return `Такая база пока не поддерживается: ${err.message}`;
  if (err && err.code === 'ENOENT') return 'Файл базы не найден';
  if (err && err.code === 'EACCES') return 'Нет доступа к файлу базы';
  return (err && err.message) || 'Не удалось открыть базу';
}

const text = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.getText === 'function') return value.getText();
  return String(value);
};

const isProtected = (value) => !!(value && typeof value.getText === 'function');

/** The uuid as a stable string the panel can hand back to us. */
const idOf = (obj) => (obj && obj.uuid && obj.uuid.id) || null;

// Fields every entry has; anything else the user added is a custom field.
const STANDARD = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);

class Vault extends EventEmitter {
  /**
   * @param {() => object} options reads the current settings each time, so a
   *        change to the path or the lock delay takes effect at once
   */
  constructor(options = () => ({})) {
    super();
    this.options = options;
    this.db = null;
    this.credentials = null;
    this.entries = [];
    this.byId = new Map();
    this.error = null;
    this.lockTimer = null;
    this.watcher = null;
    this.fileStamp = null;
  }

  // --- what the panel is allowed to know -----------------------------------
  get unlocked() {
    return !!this.db;
  }

  get file() {
    const p = this.options().vaultPath;
    return p ? String(p) : null;
  }

  get keyFile() {
    const p = this.options().vaultKeyFile;
    return p ? String(p) : null;
  }

  get lockAfterMs() {
    const n = Number(this.options().vaultLockMinutes);
    if (!Number.isFinite(n)) return DEFAULT_LOCK_MS;
    if (n <= 0) return 0; // never on its own
    return n * 60 * 1000;
  }

  status() {
    return {
      configured: !!this.file,
      file: this.file,
      keyFile: this.keyFile,
      unlocked: this.unlocked,
      count: this.entries.length,
      error: this.error,
      lockMinutes: this.lockAfterMs ? this.lockAfterMs / 60000 : 0,
    };
  }

  // --- opening --------------------------------------------------------------
  /**
   * Reads the file and decrypts it. The password never leaves this process and
   * is turned into a protected value immediately.
   */
  async unlock(password) {
    const file = this.file;
    if (!file) return { ok: false, error: 'Файл базы не выбран' };

    useArgon2();
    let credentials;
    try {
      const key = this.keyFile ? await fs.promises.readFile(this.keyFile) : null;
      credentials = new kdbxweb.Credentials(
        kdbxweb.ProtectedValue.fromString(String(password == null ? '' : password)),
        key ? new Uint8Array(key).buffer : null
      );
    } catch (err) {
      this.error = err.code === 'ENOENT' ? 'Файл-ключ не найден' : explain(err);
      return { ok: false, error: this.error };
    }

    const res = await this._open(credentials);
    if (res.ok) {
      this.credentials = credentials;
      this._checkedAt = Date.now();
      this.touch();
      this.emit('change', this.status());
    }
    return res;
  }

  async _open(credentials) {
    const file = this.file;
    let bytes;
    try {
      const raw = await fs.promises.readFile(file);
      const stat = await fs.promises.stat(file);
      this.fileStamp = `${stat.mtimeMs}:${stat.size}`;
      bytes = new Uint8Array(raw).buffer;
    } catch (err) {
      this.error = explain(err);
      return { ok: false, error: this.error };
    }

    try {
      this.db = await kdbxweb.Kdbx.load(bytes, credentials);
    } catch (err) {
      this.db = null;
      this.error = explain(err);
      return { ok: false, error: this.error };
    }

    this.error = null;
    this._index();
    return { ok: true, count: this.entries.length };
  }

  /** Re-reads the file with the key already in hand, after it changed on disk. */
  async reload() {
    if (!this.credentials) return { ok: false, error: 'База закрыта' };
    const res = await this._open(this.credentials);
    this.emit('change', this.status());
    return res;
  }

  lock(reason = 'по требованию') {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    const was = this.unlocked;
    this.db = null;
    this.credentials = null;
    this.entries = [];
    this.byId.clear();
    if (was) {
      console.log('[vault] закрыт:', reason);
      this.emit('locked', reason);
      this.emit('change', this.status());
    }
  }

  /** Puts off the automatic lock; called whenever the panel actually uses it. */
  touch() {
    if (!this.unlocked) return;
    this._checkFile();
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    const after = this.lockAfterMs;
    if (!after) return;
    this.lockTimer = setTimeout(() => this.lock('прошло время без обращений'), after);
    if (this.lockTimer.unref) this.lockTimer.unref();
  }

  // --- the file underneath --------------------------------------------------
  /**
   * Notices that KeePass saved over the file while we had it open.
   *
   * Deliberately not a file watch. A watch means a thread and a callback for
   * every write in that folder for as long as the widget runs, and the answer
   * only matters at the moment somebody actually looks something up — so the
   * check rides along with the lookups, and no more than once every couple of
   * seconds. An idle widget does nothing at all.
   */
  _checkFile() {
    if (!this.unlocked || this._checking) return;
    const now = Date.now();
    if (now - (this._checkedAt || 0) < 2000) return;
    this._checkedAt = now;
    this._checking = true;

    fs.promises
      .stat(this.file)
      .then(async (stat) => {
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        if (stamp === this.fileStamp) return;
        const res = await this.reload();
        if (res.ok) {
          console.log('[vault] база изменилась на диске, перечитана');
          this.emit('reloaded', this.entries.length);
        }
      })
      .catch(() => {
        /* mid-save the file may not be there for an instant; next time then */
      })
      .finally(() => {
        this._checking = false;
      });
  }

  // --- reading the tree -----------------------------------------------------
  /**
   * Flattens the database into what the panel needs.
   *
   * The recycle bin is skipped: a password thrown away in KeePass should not
   * come back through a search here. Groups that were told not to be searched,
   * or not to auto-type, keep those wishes.
   */
  _index() {
    this.entries = [];
    this.byId.clear();
    if (!this.db) return;

    const binId = this.db.meta.recycleBinUuid && this.db.meta.recycleBinUuid.id;

    const walk = (group, trail, searchable, autoTypeable) => {
      if (!group) return;
      if (binId && idOf(group) === binId) return;

      // KeePass stores these as true / false / null, where null means "same as
      // the group above" — which is why they are threaded through rather than
      // read on their own.
      const canSearch = group.enableSearching == null ? searchable : !!group.enableSearching;
      const canType = group.enableAutoType == null ? autoTypeable : !!group.enableAutoType;
      const here = trail ? `${trail} / ${group.name}` : group.name;

      for (const entry of group.entries || []) {
        const summary = this._summarise(entry, here, canSearch, canType);
        if (!summary) continue;
        this.entries.push(summary);
        this.byId.set(summary.id, { entry, group });
      }
      for (const child of group.groups || []) walk(child, here, canSearch, canType);
    };

    for (const root of this.db.groups || []) walk(root, '', true, true);
  }

  _summarise(entry, groupPath, canSearch, canType) {
    const id = idOf(entry);
    if (!id) return null;
    const fields = entry.fields || new Map();

    const custom = [];
    for (const [name, value] of fields) {
      if (STANDARD.has(name)) continue;
      custom.push({ name, protected: isProtected(value) });
    }

    const times = entry.times || {};
    const expires = !!times.expires && !!times.expiryTime;

    const autoType = entry.autoType || {};
    // KeePass calls the sequence attached to a window association
    // "KeystrokeSequence", and that is the name kdbxweb keeps it under.
    const items = (autoType.items || [])
      .filter((i) => i && i.window)
      .map((i) => ({
        window: String(i.window),
        sequence: i.keystrokeSequence ? String(i.keystrokeSequence) : null,
      }));

    return {
      id,
      title: text(fields.get('Title')) || '(без названия)',
      user: isProtected(fields.get('UserName')) ? '' : text(fields.get('UserName')),
      url: text(fields.get('URL')),
      // Notes can be marked protected too, and then they are a secret like any
      // other: the list gets nothing.
      notes: isProtected(fields.get('Notes')) ? '' : text(fields.get('Notes')),
      group: groupPath,
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      icon: typeof entry.icon === 'number' ? entry.icon : 0,
      hasPassword: !!fields.get('Password'),
      hasTotp: !!totp.readConfig(fields),
      fieldNames: custom.map((c) => c.name),
      customFields: custom,
      attachments: [...(entry.binaries ? entry.binaries.keys() : [])],
      history: (entry.history || []).length,
      expires,
      expired: expires && times.expiryTime.getTime() < Date.now(),
      created: times.creationTime ? times.creationTime.getTime() : null,
      modified: times.lastModTime ? times.lastModTime.getTime() : null,
      searchable: canSearch,
      autoType: {
        enabled: canType && autoType.enabled !== false,
        defaultSequence: autoType.defaultSequence ? String(autoType.defaultSequence) : null,
        items,
      },
    };
  }

  /** Everything the panel may see: titles and user names, never a secret. */
  list() {
    this.touch();
    return this.entries.filter((e) => e.searchable);
  }

  find(query, limit) {
    this.touch();
    return search(this.list(), query, limit);
  }

  /** Entries worth offering for the window in front, best first. */
  forWindow(windowTitle) {
    this.touch();
    const usable = this.list().filter((e) => e.autoType.enabled);
    return forWindow(usable, windowTitle).map((hit) => ({
      entry: hit.entry,
      score: hit.score,
      why: hit.why,
      sequence: hit.sequence,
    }));
  }

  // --- secrets, one at a time ----------------------------------------------
  /**
   * KeePass lets a field borrow its value from another entry:
   * "{REF:P@I:hex-uuid}" means "the password of that entry". Resolved here, or
   * the widget would type the reference itself into a login form.
   */
  _resolveRefs(value, depth = 0) {
    if (depth > 3 || typeof value !== 'string' || value.indexOf('{REF:') < 0) return value;

    const WANT = { T: 'Title', U: 'UserName', P: 'Password', A: 'URL', N: 'Notes' };
    return value.replace(/[{]REF:([TUPANI])@([TUPANIO]):([^}]*)[}]/gi, (whole, want, where, needle) => {
      const field = WANT[want.toUpperCase()];
      if (!field) return whole;

      const key = String(needle).trim();
      const found = this.entries.find((e) => {
        const w = where.toUpperCase();
        if (w === 'I') return e.id.replace(/[^a-z0-9]/gi, '').toLowerCase() === key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (w === 'T') return e.title === key;
        if (w === 'U') return e.user === key;
        if (w === 'A') return e.url === key;
        return false;
      });
      if (!found) return whole;
      const held = this.byId.get(found.id);
      if (!held) return whole;
      return this._resolveRefs(text(held.entry.fields.get(field)), depth + 1);
    });
  }

  /**
   * One field of one entry, in the clear.
   *
   * Everything that hands a password onward comes through here, so this is the
   * one place that has to be right about what it gives out.
   */
  secret(id, field = 'Password') {
    this.touch();
    const held = this.byId.get(id);
    if (!held) return null;
    const value = held.entry.fields.get(field);
    if (value == null) return null;
    return this._resolveRefs(text(value));
  }

  /** The current one-time code, if the entry carries a secret for one. */
  totp(id) {
    this.touch();
    const held = this.byId.get(id);
    if (!held) return null;
    const config = totp.readConfig(held.entry.fields);
    if (!config) return null;
    return totp.code(config);
  }

  /** An attachment, for saving to disk. */
  attachment(id, name) {
    this.touch();
    const held = this.byId.get(id);
    if (!held || !held.entry.binaries) return null;
    const value = held.entry.binaries.get(name);
    if (value == null) return null;
    if (value.getBinary) return Buffer.from(value.getBinary());
    if (value.value) return Buffer.from(value.value.byteLength != null ? new Uint8Array(value.value) : value.value);
    if (value.byteLength != null) return Buffer.from(new Uint8Array(value));
    return null;
  }

  /** Previous passwords KeePass kept when the entry was edited. */
  history(id) {
    this.touch();
    const held = this.byId.get(id);
    if (!held) return [];
    return (held.entry.history || [])
      .map((old) => ({
        modified: old.times && old.times.lastModTime ? old.times.lastModTime.getTime() : null,
        user: text(old.fields.get('UserName')),
        hasPassword: !!old.fields.get('Password'),
      }))
      .reverse();
  }

  // --- what to type ---------------------------------------------------------
  /**
   * The steps for typing an entry into a window, with the secrets already in
   * place. Nothing else in the app builds this list.
   *
   * @returns {{ok: boolean, steps?: Array, error?: string, title?: string}}
   */
  plan(id, windowTitle) {
    this.touch();
    const held = this.byId.get(id);
    if (!held) return { ok: false, error: 'Запись не найдена' };

    const summary = this.entries.find((e) => e.id === id);
    if (!summary || !summary.autoType.enabled) {
      return { ok: false, error: 'Для этой записи автоввод выключен' };
    }

    // A sequence written against this very window wins; then the entry's own
    // default; then KeePass's.
    const matched = forWindow([summary], windowTitle || '')[0];
    const sequence =
      (matched && matched.sequence) || summary.autoType.defaultSequence || DEFAULT_SEQUENCE;

    let actions;
    try {
      actions = parseSequence(sequence);
    } catch (err) {
      return { ok: false, error: `Последовательность записи: ${err.message}` };
    }

    const steps = [];
    for (const action of actions) {
      if (action.type !== 'field') {
        steps.push(action);
        continue;
      }
      if (action.field === 'TOTP') {
        const code = this.totp(id);
        if (!code) return { ok: false, error: 'У записи нет одноразового кода' };
        steps.push({ type: 'text', value: code.text });
        continue;
      }
      const value = this.secret(id, action.field);
      if (value == null) {
        return { ok: false, error: `У записи нет поля «${action.field}»` };
      }
      steps.push({ type: 'text', value });
    }

    return { ok: true, steps, sequence, title: summary.title };
  }
}

module.exports = { Vault, explain, useArgon2 };
