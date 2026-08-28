'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

// PowerShell cannot execute a file from inside app.asar, so the ps folder is
// unpacked at build time and the path is redirected here.
const BRIDGE = path
  .join(__dirname, '..', 'ps', 'smtc-bridge.ps1')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/**
 * Talks to the Windows System Media Transport Controls through a long-lived
 * PowerShell sidecar. Emits 'state' and 'art'; restarts itself if the sidecar
 * dies.
 */
class MediaBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buf = '';
    this.state = { active: false };
    this.art = { key: null, data: null };
    this.vol = { available: false };
    this.stopped = false;
    this.retryDelay = 1500;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  _spawn() {
    if (this.stopped) return;

    this.proc = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (t) => console.error('[smtc]', t.trim()));

    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      console.warn('[smtc] bridge exited', code, '- restarting');
      setTimeout(() => this._spawn(), this.retryDelay);
    });

    this.proc.on('error', (err) => console.error('[smtc] spawn failed', err.message));
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
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    switch (msg.type) {
      case 'state': {
        // SMTC only refreshes `position` when the player pushes an update, so
        // stamp each report and let the renderer extrapolate the clock.
        msg.stampedAt = Date.now();
        this.state = msg;
        this.emit('state', msg);
        break;
      }
      case 'vol':
        this.vol = msg;
        this.emit('vol', msg);
        break;
      case 'art':
        this.art = { key: msg.key, data: msg.data || null };
        this.emit('art', this.art);
        break;
      case 'error':
        console.error('[smtc]', msg.where, msg.message);
        break;
      case 'ready':
        break;
    }
  }

  send(cmd, arg) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(`${JSON.stringify({ cmd, arg })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  snapshot() {
    return { state: this.state, art: this.art, vol: this.vol };
  }

  stop() {
    this.stopped = true;
    if (!this.proc) return;
    this.send('quit');
    const p = this.proc;
    setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }, 300);
  }
}

module.exports = { MediaBridge };
