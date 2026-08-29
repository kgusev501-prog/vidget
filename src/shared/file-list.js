'use strict';

/**
 * Turns a clipboard file selection into history entries.
 *
 * A selection can hold a hundred thousand paths, and asking Windows about every
 * one of them takes real time — a straight synchronous loop froze the panel for
 * over a second on a large folder, and far longer on a network drive or a disk
 * that had spun down. Worse, it did that while Explorer was busy copying those
 * same files.
 *
 * So: metadata only for the ones that could plausibly be shown, read a chunk at
 * a time with a breath in between, and the rest kept as bare paths. Restoring a
 * selection to the clipboard needs nothing but the paths anyway.
 */

const STAT_LIMIT = 200;
const STAT_CHUNK = 50;

const basename = (full) => {
  const cut = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'));
  return (cut >= 0 ? full.slice(cut + 1) : full) || full;
};

/**
 * @param {string[]} paths
 * @param {object} deps
 * @param {(path: string) => Promise<{isDirectory(): boolean, size: number}>} deps.stat
 * @param {() => Promise<void>} [deps.breathe]  yields between chunks
 * @param {number} [deps.limit]
 * @param {number} [deps.chunk]
 * @returns {Promise<Array>} one entry per path, in the order given
 */
async function describe(paths, deps) {
  const stat = deps.stat;
  const breathe = deps.breathe || (() => Promise.resolve());
  const limit = deps.limit == null ? STAT_LIMIT : deps.limit;
  const chunk = deps.chunk == null ? STAT_CHUNK : deps.chunk;

  const out = [];
  for (let i = 0; i < paths.length; i++) {
    const full = paths[i];
    const entry = { path: full, name: basename(full), dir: false, size: 0 };

    if (i < limit) {
      try {
        const st = await stat(full);
        entry.dir = st.isDirectory();
        entry.size = entry.dir ? 0 : st.size;
      } catch {
        entry.missing = true;
      }
      if (chunk > 0 && i % chunk === chunk - 1) await breathe();
    } else {
      // Never looked at. Not the same as missing — we simply did not ask.
      entry.unread = true;
    }

    out.push(entry);
  }
  return out;
}

module.exports = { describe, basename, STAT_LIMIT, STAT_CHUNK };
