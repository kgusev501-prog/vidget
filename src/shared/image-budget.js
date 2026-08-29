'use strict';

/**
 * Full-quality pictures are kept as files, so the history is bounded by disk
 * space rather than by a count: sixty screenshots and sixty 48-megapixel photos
 * are the same number of entries and wildly different amounts of disk.
 *
 * Nothing pinned is ever given up. Everything else goes oldest first, and only
 * until the folder fits again.
 */

const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * @param {Array} items  history entries, newest first
 * @param {number} budgetBytes
 * @returns {{drop: Array, kept: number, total: number}} entries to forget and
 *          the byte totals before and after
 */
function planEviction(items, budgetBytes = DEFAULT_BUDGET) {
  const images = items.filter((i) => i && i.type === 'image');
  const total = images.reduce((n, i) => n + (i.bytes || 0), 0);
  if (total <= budgetBytes) return { drop: [], kept: total, total };

  // Oldest first, pinned set aside — they are kept whatever the total.
  const candidates = images.filter((i) => !i.pinned).sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const drop = [];
  let kept = total;
  for (const item of candidates) {
    if (kept <= budgetBytes) break;
    drop.push(item);
    kept -= item.bytes || 0;
  }
  return { drop, kept, total };
}

/** Bytes currently held by pictures in the history. */
function usage(items) {
  return items.reduce((n, i) => n + (i && i.type === 'image' ? i.bytes || 0 : 0), 0);
}

module.exports = { planEviction, usage, DEFAULT_BUDGET };
