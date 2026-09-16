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
        summary.groupId = idOf(group);
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
      // Notes can be marked protected, and then they are a secret like any
      // other and the list gets nothing. Even in the open they are cut short:
      // people keep recovery codes in there, and the panel has no business
      // holding those just to draw a card.
      notes: isProtected(fields.get('Notes')) ? '' : text(fields.get('Notes')).slice(0, 300),
      group: groupPath,
      tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
      icon: typeof entry.icon === 'number' ? entry.icon : 0,
      // A custom icon from the database, small enough to travel as it is.
      // KeePass users pick these to tell entries apart at a glance, and a list
      // that drops them is a list they cannot read as quickly.
      iconData: this._customIcon(entry),
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

  /** The entry's own icon out of the database, as something an <img> can show. */
  _customIcon(entry) {
    const uuid = entry.customIcon && entry.customIcon.id;
    if (!uuid || !this.db.meta.customIcons) return null;
    const icon = this.db.meta.customIcons.get(uuid);
    const data = icon && (icon.data || icon);
    if (!data || !data.byteLength) return null;
    if (data.byteLength > 64 * 1024) return null; // an icon, not a photograph
    return `data:image/png;base64,${Buffer.from(new Uint8Array(data)).toString('base64')}`;
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

  /**
   * Whether anything in the database suits this window.
   *
   * Deliberately does not count as using the vault: the strip is asked this on
   * every window change, and if that put off the automatic lock, an open
   * database would simply never close while somebody works.
   */
  hasMatchFor(windowTitle) {
    if (!this.unlocked || !windowTitle) return false;
    const usable = this.entries.filter((e) => e.searchable && e.autoType.enabled);
    return forWindow(usable, windowTitle).length > 0;
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

  // --- changing the database ------------------------------------------------
  // Writing is the one thing here that can cost somebody their passwords, so
  // every path into it goes through _write below: it refuses when KeePass has
  // the file, refuses when the file changed under us, and never leaves a
  // half-written database where the real one was.

  /** KeePass and KeePassXC both drop a lock file beside an open database. */
  lockedByKeePass() {
    const file = this.file;
    if (!file) return false;
    const candidates = [`${file}.lock`, file.replace(/[.]kdbx$/i, '.lock')];
    return candidates.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  }

  /**
   * Saves the database back where it came from.
   *
   * @param {string} what for the log, so a surprise in the file has a name
   */
  async _write(what) {
    if (!this.db) return { ok: false, error: 'База закрыта' };

    // KeePass holds the file open and will write its own copy over ours when
    // it saves. Nothing we could do here would survive that.
    if (this.lockedByKeePass()) {
      return { ok: false, error: 'База открыта в KeePass — закройте её там и повторите' };
    }

    // Somebody saved over the file since we read it. Their change is on disk
    // and ours is not; overwriting would throw theirs away.
    try {
      const stat = await fs.promises.stat(this.file);
      if (`${stat.mtimeMs}:${stat.size}` !== this.fileStamp) {
        await this.reload();
        return { ok: false, error: 'База изменилась на диске, она перечитана — повторите' };
      }
    } catch (err) {
      return { ok: false, error: explain(err) };
    }

    let bytes;
    try {
      bytes = await this.db.save();
    } catch (err) {
      return { ok: false, error: `Не удалось собрать базу: ${err.message}` };
    }

    // Written beside the real file and moved into place in one step, so an
    // interrupted save cannot leave a database that opens to nothing.
    const temp = `${this.file}.vidget-${Date.now()}`;
    try {
      await fs.promises.writeFile(temp, Buffer.from(bytes));
      await fs.promises.rename(temp, this.file);
    } catch (err) {
      fs.rm(temp, { force: true }, () => {});
      return { ok: false, error: `Не удалось записать базу: ${err.message}` };
    }

    try {
      const stat = await fs.promises.stat(this.file);
      this.fileStamp = `${stat.mtimeMs}:${stat.size}`;
      this._checkedAt = Date.now();
    } catch {
      /* it is written; the stamp will catch up on the next look */
    }

    this._index();
    console.log('[vault] записано:', what);
    this.emit('reloaded', this.entries.length);
    return { ok: true };
  }

  /**
   * The group tree, flattened in the order KeePass shows it.
   *
   * Each group knows its depth and parent, so the panel can draw the tree with
   * indents and fold branches, and how many entries it holds — directly and
   * with everything under it — so an empty branch can say so before it is
   * opened. The recycle bin is left out, as it is everywhere else here.
   */
  groups() {
    this.touch();
    if (!this.db) return [];
    const binId = this.db.meta.recycleBinUuid && this.db.meta.recycleBinUuid.id;
    const direct = new Map();
    for (const e of this.list()) direct.set(e.groupId, (direct.get(e.groupId) || 0) + 1);

    const out = [];
    const walk = (group, trail, depth, parentId) => {
      if (!group || (binId && idOf(group) === binId)) return 0;
      const id = idOf(group);
      const here = trail ? `${trail} / ${group.name}` : group.name;
      const node = { id, name: group.name, path: here, depth, parentId, count: direct.get(id) || 0, total: 0, children: 0 };
      out.push(node);
      let total = node.count;
      for (const child of group.groups || []) {
        if (binId && idOf(child) === binId) continue;
        node.children += 1;
        total += walk(child, here, depth + 1, id);
      }
      node.total = total;
      return total;
    };
    for (const root of this.db.groups || []) walk(root, '', 0, null);
    return out;
  }

  /**
   * A new group, inside the one asked for or at the top of the database.
   *
   * Goes through the same write as entries do, so it is refused while KeePass
   * has the file open and when somebody else changed it, and a failed save
   * takes the group back out rather than leaving one only the panel can see.
   */
  async createGroup({ parentId, name } = {}) {
    if (!this.db) return { ok: false, error: 'База закрыта' };
    const title = String(name || '').trim();
    if (!title) return { ok: false, error: 'Назовите группу' };
    if (title.length > 100) return { ok: false, error: 'Слишком длинное название' };

    const binId = this.db.meta.recycleBinUuid && this.db.meta.recycleBinUuid.id;
    const parent = (parentId && this._groupById(parentId)) || this.db.getDefaultGroup();
    if (!parent) return { ok: false, error: 'Некуда положить группу' };
    if (binId && idOf(parent) === binId) return { ok: false, error: 'В корзине группы не заводят' };

    // KeePass allows two groups with one name side by side, but in a tree that
    // is read at a glance they are indistinguishable, and it is nearly always
    // a second click on the same button.
    const taken = (parent.groups || []).some((g) => String(g.name || '').toLowerCase() === title.toLowerCase());
    if (taken) return { ok: false, error: `Группа «${title}» здесь уже есть` };

    const group = this.db.createGroup(parent, title);
    const res = await this._write(`новая группа «${title}»`);
    if (!res.ok) {
      parent.groups = (parent.groups || []).filter((g) => g !== group);
      return res;
    }
    return { ok: true, id: idOf(group) };
  }

  /** The group above this one, or null for the root. */
  _parentOf(target) {
    if (!this.db) return null;
    let hit = null;
    const walk = (group) => {
      if (!group || hit) return;
      for (const child of group.groups || []) {
        if (child === target) {
          hit = group;
          return;
        }
        walk(child);
      }
    };
    for (const root of this.db.groups || []) walk(root);
    return hit;
  }

  /** Gives a group another name, keeping the tree free of look-alike siblings. */
  async renameGroup(id, name) {
    if (!this.db) return { ok: false, error: 'База закрыта' };
    const group = id && this._groupById(id);
    if (!group) return { ok: false, error: 'Группа не найдена' };
    const title = String(name || '').trim();
    if (!title) return { ok: false, error: 'Назовите группу' };
    if (title.length > 100) return { ok: false, error: 'Слишком длинное название' };
    if (title === group.name) return { ok: true, id };

    const parent = this._parentOf(group);
    const siblings = parent ? parent.groups || [] : this.db.groups || [];
    const taken = siblings.some((g) => g !== group && String(g.name || '').toLowerCase() === title.toLowerCase());
    if (taken) return { ok: false, error: `Группа «${title}» здесь уже есть` };

    const was = group.name;
    group.name = title;
    if (group.times && group.times.update) group.times.update();
    const res = await this._write(`группа «${was}» теперь «${title}»`);
    if (!res.ok) {
      group.name = was;
      return res;
    }
    return { ok: true, id };
  }

  /**
   * Sends a group, with everything in it, to the recycle bin — the way KeePass
   * does it. Where the database keeps no bin, KeePass deletes for good, and so
   * does this; the panel is told which of the two it was.
   */
  async deleteGroup(id) {
    if (!this.db) return { ok: false, error: 'База закрыта' };
    const group = id && this._groupById(id);
    if (!group) return { ok: false, error: 'Группа не найдена' };
    if (!this._parentOf(group)) return { ok: false, error: 'Корень базы не удаляется' };

    const binId = this.db.meta.recycleBinUuid && this.db.meta.recycleBinUuid.id;
    if (binId && idOf(group) === binId) return { ok: false, error: 'Корзину удаляют в самом KeePass' };
    let holdsBin = false;
    const walk = (g) => {
      for (const child of g.groups || []) {
        if (binId && idOf(child) === binId) holdsBin = true;
        walk(child);
      }
    };
    walk(group);
    if (holdsBin) return { ok: false, error: 'В группе лежит корзина базы — её так не удалить' };

    const name = group.name;
    const permanent = !(this.db.meta.recycleBinEnabled && this.db.meta.recycleBinUuid);
    this.db.remove(group);
    const res = await this._write(`удаление группы «${name}»${permanent ? ' навсегда' : ''}`);
    if (!res.ok) await this.reload();
    return { ...res, name, permanent };
  }

  /** Entries in a group and in every group under it. */
  inGroup(groupId) {
    this.touch();
    const top = groupId && this._groupById(groupId);
    if (!top) return [];
    const ids = new Set();
    const walk = (group) => {
      ids.add(idOf(group));
      for (const child of group.groups || []) walk(child);
    };
    walk(top);
    return this.list().filter((e) => ids.has(e.groupId));
  }

  _groupById(id) {
    if (!this.db) return null;
    let hit = null;
    const walk = (group) => {
      if (!group || hit) return;
      if (idOf(group) === id) {
        hit = group;
        return;
      }
      for (const child of group.groups || []) walk(child);
    };
    for (const root of this.db.groups || []) walk(root);
    return hit;
  }

  /** Puts the fields of a form onto an entry, protecting what should be. */
  _applyFields(entry, fields) {
    const SECRET = new Set(['Password']);
    for (const [name, value] of Object.entries(fields || {})) {
      if (value === undefined) continue;
      if (value === null || value === '') {
        // An emptied field goes away rather than staying as an empty string,
        // which is what KeePass itself does.
        if (!STANDARD.has(name)) entry.fields.delete(name);
        else entry.fields.set(name, '');
        continue;
      }
      const wasProtected = isProtected(entry.fields.get(name));
      entry.fields.set(
        name,
        SECRET.has(name) || wasProtected ? kdbxweb.ProtectedValue.fromString(String(value)) : String(value)
      );
    }
  }

  /** A new entry in the group asked for, or in the first one there is. */
  async createEntry({ groupId, fields } = {}) {
    if (!this.db) return { ok: false, error: 'База закрыта' };
    const title = fields && fields.Title;
    if (!title || !String(title).trim()) return { ok: false, error: 'Без названия запись не найти' };

    const group = (groupId && this._groupById(groupId)) || this.db.getDefaultGroup();
    if (!group) return { ok: false, error: 'Некуда положить запись' };

    const entry = this.db.createEntry(group);
    this._applyFields(entry, fields);
    entry.times.update();

    const res = await this._write(`новая запись «${title}»`);
    if (!res.ok) {
      // Take it back out, or a failed save would leave a ghost entry in the
      // list until the next unlock.
      group.entries = group.entries.filter((e) => e !== entry);
      this._index();
      return res;
    }
    return { ok: true, id: idOf(entry) };
  }

  /** Changes an existing entry, keeping what it said before. */
  async updateEntry(id, fields, groupId) {
    if (!this.db) return { ok: false, error: 'База закрыта' };
    const held = this.byId.get(id);
    if (!held) return { ok: false, error: 'Запись не найдена' };

    // The group picked in the form. It used to be ignored on an edit: only the
    // fields were saved, and an entry stayed where it was whatever was chosen.
    const target = groupId ? this._groupById(groupId) : null;
    if (groupId && !target) return { ok: false, error: 'Группа не найдена' };
    const binId = this.db.meta.recycleBinUuid && this.db.meta.recycleBinUuid.id;
    if (target && binId && idOf(target) === binId) return { ok: false, error: 'В корзину — это удаление' };

    // The old values become a history entry, exactly as KeePass does it, so
    // nothing typed over is lost.
    held.entry.pushHistory();
    this._applyFields(held.entry, fields || {});
    held.entry.times.update();
    if (target && target !== held.group) {
      this.db.move(held.entry, target);
      if (held.entry.times.locationChanged !== undefined) held.entry.times.locationChanged = new Date();
    }

    const res = await this._write(`правка записи «${text(held.entry.fields.get('Title'))}»`);
    if (!res.ok) {
      held.entry.removeHistory(held.entry.history.length - 1);
      await this.reload();
    }
    return res;
  }

  /** Moves an entry to the recycle bin, the way KeePass does. */
  async deleteEntry(id) {
    if (!this.db) return { ok: false, error: 'База закрыта' };
    const held = this.byId.get(id);
    if (!held) return { ok: false, error: 'Запись не найдена' };
    const title = text(held.entry.fields.get('Title'));

    this.db.remove(held.entry);
    const res = await this._write(`удаление записи «${title}»`);
    if (!res.ok) await this.reload();
    return { ...res, title };
  }

  // --- secrets, one at a time ----------------------------------------------
  /**
   * KeePass lets a field borrow its value from another entry:
   * "{REF:P@I:hex-uuid}" means "the password of that entry". Resolved here, or
   * the widget would type the reference itself into a login form.
   */
  _resolveRefs(value, depth = 0, self = null) {
    if (depth > 3 || typeof value !== 'string' || value.indexOf('{') < 0) return value;

    // KeePass also lets a field quote the entry it belongs to: a URL of
    // "https://{S:host}/login" or a user name of "{TITLE}-admin" is ordinary
    // in a real database, and typing the braces themselves would be wrong.
    if (self && value.indexOf('{') >= 0) {
      const OWN = { TITLE: 'Title', USERNAME: 'UserName', URL: 'URL', PASSWORD: 'Password', NOTES: 'Notes' };
      value = value.replace(/[{]([A-Za-zА-Яа-я0-9 _:-]{1,64})[}]/g, (whole, name) => {
        const upper = name.toUpperCase();
        if (OWN[upper]) {
          const held = self.fields.get(OWN[upper]);
          return held == null ? whole : this._resolveRefs(text(held), depth + 1);
        }
        if (/^S:/i.test(name)) {
          const held = self.fields.get(name.slice(2));
          return held == null ? whole : this._resolveRefs(text(held), depth + 1);
        }
        return whole;
      });
    }

    if (value.indexOf('{REF:') < 0) return value;

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
    return this._resolveRefs(text(value), 0, held.entry);
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

  /**
   * Previous versions KeePass kept when the entry was edited, newest first.
   *
   * The old passwords are in there — that is the whole point of the history,
   * and the reason someone opens it is usually that the new one does not work
   * somewhere yet. They are not sent along, only counted: like every other
   * secret, one is handed over when asked for by number.
   */
  history(id) {
    this.touch();
    const held = this.byId.get(id);
    if (!held) return [];
    const all = held.entry.history || [];
    return all
      .map((old, index) => ({
        index,
        modified: old.times && old.times.lastModTime ? old.times.lastModTime.getTime() : null,
        user: text(old.fields.get('UserName')),
        hasPassword: !!old.fields.get('Password'),
      }))
      .reverse();
  }

  /** One field of one older version of an entry. */
  pastSecret(id, index, field = 'Password') {
    this.touch();
    const held = this.byId.get(id);
    if (!held) return null;
    const old = (held.entry.history || [])[index];
    if (!old) return null;
    const value = old.fields.get(field);
    return value == null ? null : text(value);
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
