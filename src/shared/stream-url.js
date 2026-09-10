'use strict';

const crypto = require('crypto');

// The salt the Yandex Music clients mix into the signature. It is not a secret
// — every client carries the same one — but the download host refuses a link
// signed without it.
const SALT = 'XGRlBW9FXlekgbPrRHuSiA';

/**
 * Picks the variant to play out of what /tracks/{id}/download-info offered.
 *
 * Quality is never traded away: the highest bitrate wins. A preview is a
 * thirty-second sample, which is not a track — it is taken only when nothing
 * else is on offer, so the caller can tell the difference.
 */
function pickVariant(variants, codec = 'mp3') {
  const list = (variants || []).filter((v) => v && v.codec === codec && Number.isFinite(v.bitrateInKbps));
  if (!list.length) return null;
  const full = list.filter((v) => !v.preview);
  const best = (full.length ? full : list).sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0];
  return best || null;
}

/**
 * Pulls the four fields out of the little XML the sign endpoint answers with.
 * Returns null unless all of them are there — a half-read answer would build a
 * link that the host rejects.
 */
function parseSignature(xml) {
  const field = (name) => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || '');
    return m ? m[1].trim() : '';
  };

  const host = field('host');
  const path = field('path');
  const ts = field('ts');
  const s = field('s');
  if (!host || !path || !ts || !s) return null;
  return { host, path, ts, s };
}

/** The playable link, from the signature the previous step handed back. */
function buildStreamUrl(sig) {
  if (!sig) return null;
  // The leading slash of the path is not part of what gets signed.
  const digest = crypto.createHash('md5').update(SALT + sig.path.slice(1) + sig.s).digest('hex');
  return `https://${sig.host}/get-mp3/${digest}/${sig.ts}${sig.path}`;
}

module.exports = { pickVariant, parseSignature, buildStreamUrl, SALT };
