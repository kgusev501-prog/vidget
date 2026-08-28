'use strict';

const { EventEmitter } = require('events');
const { runPs } = require('./ps');

/**
 * The Yandex Music desktop app.
 *
 * Windows publishes a media session only while the player runs, so after a
 * reboot the widget has nothing to talk to until the app is open. This starts
 * it — minimized, so it does not steal the desktop on login.
 */
class Player extends EventEmitter {
  constructor() {
    super();
    this.path = null;
    this.running = false;
    this.busy = false;
  }

  async status() {
    const res = await runPs('player.ps1', ['-Mode', 'status'], { timeout: 12000 });
    if (res) {
      this.path = res.path || null;
      this.running = !!res.running;
    }
    return { installed: !!this.path, running: this.running };
  }

  /** Hands a track to the desktop player without letting it grab the screen. */
  async playUrl(url) {
    const res = await runPs('player.ps1', ['-Mode', 'play', '-Url', url], { timeout: 20000 });
    return res || { ok: false, reason: 'error' };
  }

  /** Starts the player if it is installed and not already up. */
  async launch({ minimized = false } = {}) {
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    let res = null;
    try {
      const args = ['-Mode', 'launch'];
      if (minimized) args.push('-Minimized');
      res = await runPs('player.ps1', args, { timeout: 20000 });
    } finally {
      this.busy = false;
    }

    if (!res) return { ok: false, reason: 'error' };
    if (res.path) this.path = res.path;
    if (res.ok) this.running = true;
    this.emit('change', { installed: !!this.path, running: this.running });
    return res;
  }
}

module.exports = { Player };
