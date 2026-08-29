'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { clipboard, nativeImage } = require('electron');

const { runPs, spawnPs } = require('./ps');
const { ImageStore } = require('./image-store');
const { classify } = require('../shared/classify');
const { encode: encodePng, bgraToRgba } = require('../shared/png');
const { planEviction, usage, DEFAULT_BUDGET } = require('../shared/image-budget');

const MAX_ITEMS = 300;
const MAX_IMAGES = 200; // a sanity cap; the byte budget is what really bounds it
const POLL_MS = 450;
const MAX_TEXT = 200000;
const MAX_FILES = 60;
const THUMB_H = 160;

// A file selection can hold a hundred thousand paths. Metadata is read for the
// ones that could plausibly be shown, and the rest are kept as paths — which is
// all that restoring them to the clipboard needs anyway.
const STAT_LIMIT = 200;
const STAT_CHUNK = 50;

// Copied files live on the clipboard as CF_HDROP. Electron reports the format
// as text/uri-list and returns only the first path, so the full list and any
// write-back go through a short PowerShell call.
const runClipPs = (args) => runPs('clip-files.ps1', args, { sta: true });

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const idle = () => new Promise((r) => setImmediate(r));

/**
 * Polls the system clipboard and keeps a de-duplicated history of text and
 * images.
 *
 * Windows announces every clipboard write through a sequence number, and the
 * watcher below reports it. Nothing here reads the clipboard's contents until
 * that number moves — reading a picture means decoding it, and doing that on a
 * timer for a picture already seen is how a widget ends up holding a core at
 * 100 % for as long as a screenshot sits in the clipboard.
 *
 * Pictures are kept as files at full quality and referred to by path. Only a
 * small preview travels with the index; the picture itself is fetched when
 * something actually needs it.
 */
class ClipboardWatcher extends EventEmitter {
  constructor(store, imageDir, options = () => ({})) {
    super();
    this.store = store;
    this.imageDir = imageDir;
    this.options = options; // read fresh each time, so a change takes effect at once
    this.timer = null;
    this.lastSig = null;
    this.suppressUntil = 0;
    this.watcher = null;
    this.watcherBuf = '';
    this.origin = null; // loopback origin the panel is served from

    // Gate on the clipboard sequence number. Until the watcher reports one,
    // every tick reads — that is the old behaviour, and the right fallback if
    // the watcher never comes up.
    this.seq = null;
    this.dirty = true;

    this.images = new ImageStore(imageDir, (bitmap, w, h) => encodePng(bgraToRgba(bitmap), w, h, { level: 6 }));
    this._pruneOrphans();
  }

  get items() {
    return this.store.get().items || [];
  }

  set items(next) {
    this.store.set({ items: next });
  }

  /** The panel's origin, once the loopback server is up. */
  setOrigin(origin) {
    this.origin = origin || null;
  }

  get budget() {
    const n = Number(this.options().imageBudget);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
  }

  start() {
    if (this.timer) return;
    this._read(true); // seed, do not record what was already on the clipboard
    this.timer = setInterval(() => this._read(false), POLL_MS);
    this._startWatcher();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._stopWatcher();
    this.images.stop();
    this.store.flush();
  }

  // --- the change signal -------------------------------------------------
  // Detection has to happen on the Windows side: Electron cannot tell two file
  // selections apart when they begin with the same file, and it has no way at
  // all to ask whether the clipboard changed.
  _startWatcher() {
    if (this.watcher) return;
    try {
      this.watcher = spawnPs('clip-files.ps1', ['-Mode', 'watch'], { sta: true });
    } catch (err) {
      console.error('[clipboard] file watcher failed to start', err.message);
      this.watcher = null;
      this.seq = null; // no signal: go back to reading on every tick
      return;
    }

    this.watcher.stdout.setEncoding('utf8');
    this.watcher.stdout.on('data', (chunk) => this._onWatcher(chunk));
    this.watcher.stderr.setEncoding('utf8');
    this.watcher.stderr.on('data', (t) => console.error('[clipfiles]', t.trim()));

    this.watcher.on('exit', (code) => {
      this.watcher = null;
      this.seq = null;
      this.dirty = true;
      if (!this.timer) return; // stopped on purpose
      console.warn('[clipfiles] watcher exited', code, '- restarting');
      setTimeout(() => this._startWatcher(), 2000);
    });
  }

  _stopWatcher() {
    if (!this.watcher) return;
    const child = this.watcher;
    this.watcher = null;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  _onWatcher(chunk) {
    this.watcherBuf += chunk;
    let idx;
    while ((idx = this.watcherBuf.indexOf('\n')) >= 0) {
      const line = this.watcherBuf.slice(0, idx).trim();
      this.watcherBuf = this.watcherBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type === 'ready' || msg.type === 'seq') {
        // Windows says the clipboard changed — the only thing that ever makes
        // it worth looking at what is in it. The watcher's opening message
        // carries the current number too, so the gate closes from the start
        // rather than after the first copy; one read follows either way, in
        // case something was copied while the watcher was still starting up.
        if (msg.n != null) this.seq = msg.n;
        this.dirty = true;
        this._read(false);
        continue;
      }

      if (msg.type !== 'files') continue;
      if (Date.now() < this.suppressUntil) continue;
      this._addFiles(asArray(msg.paths).filter(Boolean)).catch((err) =>
        console.error('[clipboard] file list failed', err.message)
      );
    }
  }

  _read(seedOnly) {
    // Nothing has changed since the last look, and the watcher is the one
    // telling us so. Reading again could only produce what we already have.
    if (!seedOnly && this.seq !== null && !this.dirty) return;
    this.dirty = false;

    let formats;
    try {
      formats = clipboard.availableFormats();
    } catch {
      return;
    }
    if (!formats.length) return;

    const hasFiles = formats.includes('text/uri-list');
    const hasImage = formats.some((f) => f.startsWith('image/'));
    const hasText = formats.some((f) => f === 'text/plain' || f === 'text/html');

    // Files are handled by the watcher above; nothing here can read them.
    if (hasFiles && !hasImage && !hasText) return;

    if (hasImage && this.options().keepImages === false) return;

    if (hasImage) {
      let img;
      try {
        img = clipboard.readImage();
      } catch {
        return;
      }
      if (img.isEmpty()) return;

      // The signature comes from a thumbnail, never from the full picture:
      // encoding megapixels only to find out we have seen them before is the
      // most expensive way possible to answer a cheap question.
      const size = img.getSize();
      let thumb;
      try {
        thumb = img.resize({ height: Math.min(THUMB_H, size.height), quality: 'good' });
      } catch {
        return;
      }
      const sig = `i:${size.width}x${size.height}:${hash(thumb.toBitmap())}`;
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      if (seedOnly || Date.now() < this.suppressUntil) return;
      this._addImage(img, thumb, size, sig).catch((err) =>
        console.error('[clipboard] image failed', err.message)
      );
      return;
    }

    if (!hasText) return;
    let text;
    try {
      text = clipboard.readText();
    } catch {
      return;
    }
    if (!text || !text.trim()) return;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    const sig = `t:${hash(text)}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (seedOnly || Date.now() < this.suppressUntil) return;
    this._addText(text, sig);
  }

  async _addFiles(paths) {
    if (!paths.length) return;

    // Metadata is read a chunk at a time with a breath in between, so a
    // selection of a hundred thousand files cannot freeze the panel — or make
    // the widget compete with Explorer for the disk while it is copying them.
    const files = [];
    for (let i = 0; i < paths.length; i++) {
      const full = paths[i];
      const entry = { path: full, name: path.basename(full) || full, dir: false, size: 0 };
      if (i < STAT_LIMIT) {
        try {
          const st = await fs.promises.stat(full);
          entry.dir = st.isDirectory();
          entry.size = st.isDirectory() ? 0 : st.size;
        } catch {
          entry.missing = true;
        }
        if (i % STAT_CHUNK === STAT_CHUNK - 1) await idle();
      } else {
        entry.unread = true; // kept as a path; restoring needs nothing more
      }
      files.push(entry);
    }

    const sig = `d:${hash(paths.join('\n'))}`;
    this._push({
      id: sig.slice(2, 14) + Date.now().toString(36),
      sig,
      type: 'files',
      kind: 'files',
      files,
      ts: Date.now(),
      pinned: false,
    });
  }

  _addText(text, sig) {
    const lines = text.split('\n');
    this._push({
      id: sig.slice(2, 14) + Date.now().toString(36),
      sig,
      type: 'text',
      kind: classify(text),
      text,
      preview: lines.slice(0, 6).join('\n').slice(0, 400),
      chars: text.length,
      lines: lines.length,
      ts: Date.now(),
      pinned: false,
    });
  }

  /**
   * The entry appears at once with its preview; the full-quality file is
   * written in the background and its size filled in when it lands.
   */
  async _addImage(img, thumb, size, sig) {
    const id = hash(sig).slice(0, 12) + Date.now().toString(36);

    try {
      await this.images.saveThumb(id, thumb.toPNG());
    } catch (err) {
      console.error('[clipboard] thumbnail failed', err.message);
    }

    this._push({
      id,
      sig,
      type: 'image',
      kind: 'image',
      file: this.images.file(id),
      w: size.width,
      h: size.height,
      bytes: 0,
      pending: true,
      ts: Date.now(),
      pinned: false,
    });

    let bytes = 0;
    try {
      bytes = await this.images.save(id, img.toBitmap(), size.width, size.height);
    } catch (err) {
      console.error('[clipboard] could not save the picture', err.message);
      this.remove(id);
      return;
    }

    this._patch(id, { bytes, pending: false });
    this._enforceBudget();
  }

  /** Updates one entry in place, if it is still there. */
  _patch(id, fields) {
    let found = false;
    const next = this.items.map((it) => {
      if (it.id !== id) return it;
      found = true;
      return { ...it, ...fields };
    });
    if (!found) return;
    this.items = next;
    this.emit('change', next);
  }

  _push(entry) {
    let items = this.items.filter((it) => it.sig !== entry.sig || it.pinned);
    items.unshift(entry);
    items = this._trim(items);
    this.items = items;
    this.emit('change', items);
  }

  _trim(items) {
    const limit = Number(this.options().clipLimit) || MAX_ITEMS;
    const imageLimit = this.options().keepImages === false ? 0 : MAX_IMAGES;

    const keep = [];
    let texts = 0;
    let images = 0;
    let files = 0;
    for (const it of items) {
      if (it.pinned) {
        keep.push(it);
        continue;
      }
      if (it.type === 'image') {
        if (images++ < imageLimit) keep.push(it);
        else this._unlink(it);
      } else if (it.type === 'files') {
        if (files++ < MAX_FILES) keep.push(it);
      } else if (texts++ < limit) {
        keep.push(it);
      }
    }
    return keep;
  }

  /** Keeps the pictures folder inside its budget, oldest first, pinned safe. */
  _enforceBudget() {
    const { drop, total, kept } = planEviction(this.items, this.budget);
    if (!drop.length) return;
    const gone = new Set(drop.map((d) => d.id));
    for (const item of drop) this._unlink(item);
    this.items = this.items.filter((i) => !gone.has(i.id));
    console.log(
      `[clipboard] pictures ${Math.round(total / 1048576)} MB over budget, forgot ${drop.length} → ${Math.round(kept / 1048576)} MB`
    );
    this.emit('change', this.items);
  }

  _unlink(item) {
    if (item.type !== 'image') return;
    this.images.remove(item.id);
  }

  _pruneOrphans() {
    const known = new Set(this.items.filter((i) => i.type === 'image').map((i) => i.id));
    this.images.pruneOrphans(known);
  }

  /** Put an entry back on the clipboard without re-recording it. */
  async restore(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    this.suppressUntil = Date.now() + 1200;

    if (item.type === 'files') {
      this.suppressUntil = Date.now() + 3000;
      const listFile = path.join(os.tmpdir(), `vidget-clip-${Date.now()}.json`);
      let res = null;
      try {
        fs.writeFileSync(listFile, JSON.stringify(item.files.map((f) => f.path)), 'utf8');
        res = await runClipPs(['-Mode', 'write', '-ListFile', listFile]);
      } catch {
        res = null;
      }
      fs.rm(listFile, { force: true }, () => {});
      if (!res || !res.ok) return false;
      this.lastSig = `f:${item.files[0].path}`;
      this._bump(item);
      return true;
    }

    if (item.type === 'image') {
      // Still being written; the pixels are not on disk yet.
      if (item.pending) return false;
      try {
        const img = nativeImage.createFromPath(item.file);
        if (img.isEmpty()) return false;
        clipboard.writeImage(img);
      } catch {
        return false;
      }
    } else {
      clipboard.writeText(item.text);
    }
    this.lastSig = item.sig;
    this._bump(item);
    return true;
  }

  /** Move an entry to the front, where the eye already is. */
  _bump(item) {
    const rest = this.items.filter((i) => i.id !== item.id);
    this.items = [{ ...item, ts: Date.now() }, ...rest];
    this.emit('change', this.items);
  }

  remove(id) {
    const item = this.items.find((i) => i.id === id);
    if (item) this._unlink(item);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit('change', this.items);
  }

  togglePin(id) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, pinned: !i.pinned } : i));
    this.emit('change', this.items);
  }

  clear(keepPinned = true) {
    const kept = keepPinned ? this.items.filter((i) => i.pinned) : [];
    for (const it of this.items) if (!kept.includes(it)) this._unlink(it);
    this.items = kept;
    this.emit('change', this.items);
  }

  /** Bytes the pictures folder is holding, for the settings screen. */
  imageUsage() {
    return { bytes: usage(this.items), budget: this.budget };
  }

  // --- what the panel gets ----------------------------------------------
  /**
   * Addresses for a picture. Served over the loopback origin so the panel can
   * load it like any other image; without a server there is no origin to serve
   * from, and the bytes have to be inlined instead.
   */
  _imageUrl(name) {
    if (this.origin) return `${this.origin}/clip/${name}`;
    try {
      const png = fs.readFileSync(path.join(this.imageDir, name));
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      return null;
    }
  }

  /** Strips the index down for IPC: image bytes never cross the wire. */
  listForRenderer() {
    return this.items.map((i) =>
      i.type === 'files'
        ? {
            id: i.id,
            type: i.type,
            kind: i.kind,
            files: i.files.slice(0, 4).map((f) => ({ name: f.name, dir: f.dir, size: f.size, missing: !!f.missing })),
            count: i.files.length,
            ts: i.ts,
            pinned: i.pinned,
          }
        : i.type === 'image'
        ? {
            id: i.id,
            type: i.type,
            kind: i.kind,
            thumbUrl: this._imageUrl(`${i.id}.thumb.png`),
            w: i.w,
            h: i.h,
            bytes: i.bytes,
            pending: !!i.pending,
            ts: i.ts,
            pinned: i.pinned,
          }
        : {
            id: i.id,
            type: i.type,
            kind: i.kind,
            preview: i.preview,
            chars: i.chars,
            lines: i.lines,
            ts: i.ts,
            pinned: i.pinned,
          }
    );
  }

  /** Full payload for the preview pane; a picture comes back as an address. */
  full(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    if (item.type === 'text') return { type: 'text', text: item.text };
    if (item.type === 'files') return { type: 'files', files: item.files };
    if (item.pending) return { type: 'image', pending: true, w: item.w, h: item.h };
    return {
      type: 'image',
      url: this._imageUrl(`${item.id}.png`),
      w: item.w,
      h: item.h,
      bytes: item.bytes,
    };
  }
}

module.exports = { ClipboardWatcher };
