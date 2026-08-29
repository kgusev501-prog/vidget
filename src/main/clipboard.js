'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { clipboard, nativeImage } = require('electron');

const { runPs, spawnPs } = require('./ps');
const { classify } = require('../shared/classify');

const MAX_ITEMS = 300;
const MAX_IMAGES = 60;
const POLL_MS = 450;
const MAX_TEXT = 200000;
const MAX_FILES = 60;

// Copied files live on the clipboard as CF_HDROP. Electron reports the format
// as text/uri-list and returns only the first path, so the full list and any
// write-back go through a short PowerShell call.
const runClipPs = (args) => runPs('clip-files.ps1', args, { sta: true });

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');


/**
 * Polls the system clipboard and keeps a de-duplicated history of text and
 * images. Images live as PNG files next to the JSON index; the index only
 * carries a small inline thumbnail so the renderer stays light.
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
    this.watcherSeeded = false;
    fs.mkdirSync(imageDir, { recursive: true });
    this._pruneOrphans();
  }

  get items() {
    return this.store.get().items || [];
  }

  set items(next) {
    this.store.set({ items: next });
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
    this.store.flush();
  }

  // --- copied files -----------------------------------------------------
  // Detection has to happen on the Windows side: Electron cannot tell two file
  // selections apart when they begin with the same file.
  _startWatcher() {
    if (this.watcher) return;
    try {
      this.watcher = spawnPs('clip-files.ps1', ['-Mode', 'watch'], { sta: true });
    } catch (err) {
      console.error('[clipboard] file watcher failed to start', err.message);
      this.watcher = null;
      return;
    }

    this.watcher.stdout.setEncoding('utf8');
    this.watcher.stdout.on('data', (chunk) => this._onWatcher(chunk));
    this.watcher.stderr.setEncoding('utf8');
    this.watcher.stderr.on('data', (t) => console.error('[clipfiles]', t.trim()));

    this.watcher.on('exit', (code) => {
      this.watcher = null;
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
      if (msg.type !== 'files') continue;
      if (Date.now() < this.suppressUntil) continue;
      this._addFiles(asArray(msg.paths).filter(Boolean));
    }
  }

  _read(seedOnly) {
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
      const png = img.toPNG();
      const sig = `i:${hash(png)}`;
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      if (seedOnly || Date.now() < this.suppressUntil) return;
      this._addImage(img, png, sig);
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

  _addFiles(paths) {
    if (!paths.length) return;

    const files = paths.map((full) => {
      const entry = { path: full, name: path.basename(full) || full, dir: false, size: 0 };
      try {
        const st = fs.statSync(full);
        entry.dir = st.isDirectory();
        entry.size = st.isDirectory() ? 0 : st.size;
      } catch {
        entry.missing = true;
      }
      return entry;
    });

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

  _addImage(img, png, sig) {
    const size = img.getSize();
    const id = sig.slice(2, 14) + Date.now().toString(36);
    const file = path.join(this.imageDir, `${id}.png`);
    try {
      fs.writeFileSync(file, png);
    } catch (err) {
      console.error('[clipboard] image write failed', err.message);
      return;
    }
    let thumb = null;
    try {
      const scale = img.resize({ height: Math.min(160, size.height), quality: 'good' });
      thumb = scale.toDataURL();
    } catch {
      /* thumbnail is optional */
    }
    this._push({
      id,
      sig,
      type: 'image',
      kind: 'image',
      file,
      thumb,
      w: size.width,
      h: size.height,
      bytes: png.length,
      ts: Date.now(),
      pinned: false,
    });
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

  _unlink(item) {
    if (item.type !== 'image' || !item.file) return;
    fs.rm(item.file, { force: true }, () => {});
  }

  _pruneOrphans() {
    const known = new Set(this.items.filter((i) => i.type === 'image').map((i) => path.basename(i.file || '')));
    let files;
    try {
      files = fs.readdirSync(this.imageDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!known.has(f)) fs.rm(path.join(this.imageDir, f), { force: true }, () => {});
    }
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
      try {
        clipboard.writeImage(nativeImage.createFromPath(item.file));
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

  /** Strip the index down for IPC: full image bytes never cross the wire. */
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
        ? { id: i.id, type: i.type, kind: i.kind, thumb: i.thumb, w: i.w, h: i.h, bytes: i.bytes, ts: i.ts, pinned: i.pinned }
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

  /** Full payload for the preview pane; images come back as a data URL. */
  full(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    if (item.type === 'text') return { type: 'text', text: item.text };
    if (item.type === 'files') return { type: 'files', files: item.files };
    try {
      const png = fs.readFileSync(item.file);
      return {
        type: 'image',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        w: item.w,
        h: item.h,
        bytes: item.bytes,
      };
    } catch {
      return null;
    }
  }
}

module.exports = { ClipboardWatcher };
