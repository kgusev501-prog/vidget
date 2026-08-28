'use strict';

const { norm } = require('./format');

/**
 * How well one search result answers "this exact track".
 *
 * Title and performer are scored apart on purpose. Search is deliberately
 * fuzzy — a query returns covers, remixes and karaoke — and a performer whose
 * name merely contains the one we want ("Кино Фильм" for "КИНО") must not
 * outrank the real one.
 */
function scoreTrack(entry, wantTitle, wantArtist) {
  const gotTitle = norm(entry.title);
  const artists = (entry.artists || []).map((a) => norm(a.name)).filter(Boolean);
  const joined = artists.join(' ');

  let title = 0;
  if (gotTitle && gotTitle === wantTitle) title = 3;
  else if (gotTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle))) title = 1;

  let artist = 0;
  if (wantArtist) {
    if (artists.includes(wantArtist)) artist = 3; // this performer, exactly
    else if (joined === wantArtist) artist = 3; // the whole line-up, written as one
    else if (joined.includes(wantArtist)) artist = 2; // one of several named
    else if (wantArtist.split(' ').some((w) => w.length > 3 && joined.includes(w))) artist = 1;
  }

  return { title, artist, total: title * 2 + artist };
}

/**
 * Picks the result that is really the track we were told about, or nothing.
 *
 * Refusing to answer matters: a wrong pick means liking someone else's cover or
 * playing the wrong song, which is worse than leaving the heart inactive.
 */
function pickBestTrack(results, artist, title) {
  const wantTitle = norm(title);
  const wantArtist = norm(artist);
  if (!wantTitle) return null;

  let best = null;
  let bestScore = null;

  for (const entry of (results || []).slice(0, 8)) {
    if (!entry || !entry.id) continue;
    const score = scoreTrack(entry, wantTitle, wantArtist);

    // When the performer is known, both halves have to agree; otherwise only an
    // outright title match is trustworthy.
    const acceptable = wantArtist ? score.title > 0 && score.artist > 0 : score.title === 3;
    if (!acceptable) continue;

    if (!bestScore || score.total > bestScore.total) {
      bestScore = score;
      best = entry;
    }
  }

  return best;
}

module.exports = { pickBestTrack, scoreTrack };
