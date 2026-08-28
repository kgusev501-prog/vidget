'use strict';

/** Milliseconds as m:ss, the way a track length is written. */
function mmss(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Yandex hands out cover templates like "avatars.../%%"; fill in the size. */
function coverUrl(uri, size) {
  return uri ? `https://${uri.replace('%%', size)}` : null;
}

/** Folds case, ё and punctuation so two spellings of a title can be compared. */
function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

module.exports = { mmss, coverUrl, norm };
