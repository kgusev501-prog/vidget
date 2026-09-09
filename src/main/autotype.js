'use strict';

const { EventEmitter } = require('events');

const { spawnPs } = require('./ps');

/**
 * Knowing which window the user is in, and typing an entry into it.
 *
 * Both live in one sidecar, and it only runs when a password database is set
 * up: a widget nobody uses for passwords pays nothing for this.
 *
 * Asking "which window is in front?" at the moment the hotkey is pressed
 * answers with the panel itself, so the answer is kept current beforehand and
 * windows belonging to the widget are ignored.
 *
 * Windows does not let one process hand the foreground to another, so nothing
 * here tries. The widget stops being the front window, Windows restores
 * whatever was under it, and the sidecar checks that what came forward is the
 * window the entry was chosen for — the one failure this must never have is
 * typing a password into something else.
 */

const REASONS = {
  'wrong-window': 'Впереди оказалось другое окно — ничего не напечатано',
  'unknown-key': 'В последовательности записи есть клавиша, которой мы не знаем',
  'unknown-step': 'Не удалось разобрать, что печатать',
};

class AutoType extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buf = '';
    this.window = null; // the last window that was not ours
    this.pending = null;
    this.stopped = true;
  }

  get running() {
    return !!this.proc;
  }

  /** The window the user was working in, as far as we know. */
  front() {
    return this.window;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  _spawn() {
    if (this.stopped || this.proc) return;
    let child;
    try {
      child = spawnPs('autotype.ps1', ['-ParentPid', String(process.pid)], { stdin: true });
    } catch (err) {
      console.error('[autotype] не запустился:', err.message);
      return;
    }
    this.proc = child;
    this.buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (t) => console.error('[autotype]', t.trim()));

    child.on('exit', (code) => {
      if (this.proc === child) this.proc = null;
      this._settle({ ok: false, error: 'Ввод прервался' });
      if (this.stopped) return;
      console.warn('[autotype] сидекар вышел', code, '- перезапуск');
      setTimeout(() => this._spawn(), 2000);
    });
    child.on('error', (err) => console.error('[autotype] сбой:', err.message));
  }

  _settle(result) {
    if (!this.pending) return;
    const done = this.pending;
    this.pending = null;
    done(result);
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type === 'window') {
        this.window = { title: msg.title || '', process: msg.process || '' };
        this.emit('window', this.window);
      } else if (msg.type === 'typed') {
        this._settle(
          msg.ok
            ? { ok: true, window: msg.window }
            : { ok: false, error: REASONS[msg.reason] || 'Не удалось напечатать', got: msg.got }
        );
      } else if (msg.type === 'error') {
        console.error('[autotype]', msg.message);
      }
    }
  }

  /**
   * Sends the keystrokes, but only into the window they were meant for.
   *
   * @param {Array} steps from Vault#plan — text and keys, secrets already in
   * @param {string} expect the window title that must be in front
   * @param {number} [rate] milliseconds between keystrokes
   */
  type(steps, expect, rate) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.resolve({ ok: false, error: 'Автоввод не готов' });
    }
    if (this.pending) return Promise.resolve({ ok: false, error: 'Уже печатаем' });

    return new Promise((resolve) => {
      const guard = setTimeout(() => {
        this._settle({ ok: false, error: 'Нужное окно так и не вышло вперёд' });
      }, 12000);

      this.pending = (result) => {
        clearTimeout(guard);
        resolve(result);
      };

      try {
        this.proc.stdin.write(`${JSON.stringify({ cmd: 'type', expect, steps, rate })}\n`);
      } catch (err) {
        this._settle({ ok: false, error: err.message });
      }
    });
  }

  stop() {
    this.stopped = true;
    const child = this.proc;
    this.proc = null;
    this.window = null;
    this.buf = '';
    this._settle({ ok: false, error: 'Автоввод выключен' });
    if (!child) return;
    try {
      if (child.stdin.writable) child.stdin.write('{"cmd":"quit"}\n');
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { AutoType, REASONS };
