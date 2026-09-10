'use strict';

// A timed line looks like "[01:23.45] текст"; the hundredths may be separated
// by a dot or a colon, and Yandex sometimes writes only two of them.
const TIMED = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s?(.*)$/;

/**
 * Turns an LRC file into the lines a panel can follow.
 *
 * Only timed lines survive: the tags at the top ([ar:…], [ti:…]) are about the
 * song, not about any moment in it, and a line nobody can point at in time is
 * no use to somebody trying to sing along.
 *
 * Returns lines sorted by time, each { at: seconds, text }.
 */
function parseLrc(source) {
  const lines = [];

  for (const raw of String(source || '').split(/\r?\n/)) {
    const m = TIMED.exec(raw);
    if (!m) continue;

    const [, mm, ss, frac, text] = m;
    // "45" after the dot means hundredths, "450" means thousandths.
    const fraction = frac ? Number(frac) / 10 ** frac.length : 0;
    const at = Number(mm) * 60 + Number(ss) + fraction;
    if (!Number.isFinite(at)) continue;

    lines.push({ at, text: text.trim() });
  }

  // A stable sort keeps two lines stamped at the same second in the order the
  // file wrote them, which is the order they are meant to be read.
  return lines.sort((a, b) => a.at - b.at);
}

/**
 * Which line is being sung at a given moment, as an index.
 *
 * -1 means the song has not reached the first line yet — the intro, where the
 * panel should show nothing rather than the first line early.
 */
function lineAt(lines, seconds) {
  const t = Number(seconds);
  if (!Array.isArray(lines) || !lines.length || !Number.isFinite(t)) return -1;

  // Binary search: this runs on every animation frame while a track plays.
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].at <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

module.exports = { parseLrc, lineAt };
