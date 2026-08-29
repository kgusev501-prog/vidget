'use strict';

const fs = require('fs');
const path = require('path');
const { utilityProcess } = require('electron');

/**
 * Writes clipboard pictures to disk without holding up the main process.
 *
 * The encoder lives in a utility process that is started when there is a
 * picture to write and shut down again once it has been idle for a while, so
 * an idle widget carries no cost for a feature nobody is using. If it cannot
 * be started at all, the caller's own encoder is used instead — slower and on
 * the main thread, but the picture is never lost.
 */

const IDLE_MS = 30000;
const JOB_TIMEOUT_MS = 120000; // a 48-megapixel photo takes a few seconds

class ImageStore {
  /**
   * @param {string} dir  folder for the PNG files
   * @param {(bitmapBgra: Buffer, width: number, height: number) => Buffer} fallbackEncode
   */
  constructor(dir, fallbackEncode) {
    this.dir = dir;
    this.fallbackEncode = fallbackEncode;
    this.child = null;
    this.idleTimer = null;
    this.jobs = new Map();
    this.nextId = 1;
    this.workerBroken = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.png`);
  }

  thumbFile(id) {
    return path.join(this.dir, `${id}.thumb.png`);
  }

  // --- worker ------------------------------------------------------------
  _spawn() {
    if (this.child || this.workerBroken) return this.child;
    try {
      this.child = utilityProcess.fork(path.join(__dirname, 'image-worker.js'), [], {
        serviceName: 'vidget-image',
        stdio: 'ignore',
      });
    } catch (err) {
      console.error('[images] worker failed to start', err.message);
      this.workerBroken = true;
      this.child = null;
      return null;
    }

    this.child.on('message', (msg) => this._settle(msg));
    this.child.on('exit', () => {
      this.child = null;
      // Anything still waiting will never hear back; let it fall through to
      // the caller's encoder rather than hang.
      for (const [id, job] of this.jobs) {
        this.jobs.delete(id);
        job.reject(new Error('worker exited'));
      }
    });
    return this.child;
  }

  _settle(msg) {
    if (!msg || msg.id == null) return;
    const job = this.jobs.get(msg.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    clearTimeout(job.timer);
    this._touchIdle();
    if (msg.ok) job.resolve(msg.bytes);
    else job.reject(new Error(msg.message || 'encode failed'));
  }

  /** Shuts the worker down once nothing has needed it for a while. */
  _touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.jobs.size) return;
      this._kill();
    }, IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _kill() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  // --- writing -----------------------------------------------------------
  /**
   * Saves the picture at full quality. Resolves with the file's size in bytes.
   *
   * @param {string} id
   * @param {Buffer} bitmapBgra  raw pixels straight from nativeImage.toBitmap()
   * @param {number} width
   * @param {number} height
   */
  async save(id, bitmapBgra, width, height) {
    const file = this.file(id);
    const child = this._spawn();

    if (child) {
      try {
        return await this._offload(child, { id, file, bitmapBgra, width, height });
      } catch (err) {
        console.warn('[images] worker could not encode, doing it here:', err.message);
      }
    }

    // Fallback: the caller's encoder, on this thread. Slower, but the sequence
    // gate means it happens once per copy rather than on every poll.
    const png = this.fallbackEncode(bitmapBgra, width, height);
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.part`;
    await fs.promises.writeFile(tmp, png);
    await fs.promises.rename(tmp, file);
    return png.length;
  }

  _offload(child, { id, file, bitmapBgra, width, height }) {
    return new Promise((resolve, reject) => {
      const jobId = this.nextId++;
      const timer = setTimeout(() => {
        this.jobs.delete(jobId);
        reject(new Error('encode timed out'));
      }, JOB_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      this.jobs.set(jobId, { resolve, reject, timer });
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      try {
        child.postMessage({
          type: 'encode',
          id: jobId,
          file,
          width,
          height,
          level: 6,
          bitmap: bitmapBgra,
        });
      } catch (err) {
        this.jobs.delete(jobId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Writes the small preview the list shows. Already tiny; done inline. */
  async saveThumb(id, png) {
    const file = this.thumbFile(id);
    try {
      await fs.promises.writeFile(file, png);
      return file;
    } catch (err) {
      console.error('[images] thumbnail write failed', err.message);
      return null;
    }
  }

  // --- housekeeping ------------------------------------------------------
  remove(id) {
    fs.rm(this.file(id), { force: true }, () => {});
    fs.rm(this.thumbFile(id), { force: true }, () => {});
  }

  /** Deletes files no history entry points at any more. */
  pruneOrphans(keepIds) {
    let files;
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of files) {
      const id = name.replace(/\.thumb\.png$|\.png$|\.png\.part$/, '');
      if (!keepIds.has(id)) fs.rm(path.join(this.dir, name), { force: true }, () => {});
    }
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this._kill();
  }
}

module.exports = { ImageStore };
