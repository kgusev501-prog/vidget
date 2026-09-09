'use strict';

const crypto = require('crypto');

/**
 * One-time codes for entries that carry a shared secret.
 *
 * KeePass never agreed on one place to keep these, so a database in the wild
 * holds them in whichever shape the tool that wrote it preferred:
 *
 *   - KeePassXC writes an `otp` field holding a whole `otpauth://` URI;
 *   - KeeOtp writes an `otp` field of `key=...&size=6&step=30`;
 *   - the KeeWeb and KeeTrayTOTP plugins write `TOTP Seed` beside a
 *     `TOTP Settings` of `30;6` — or `30;S` for Steam, which uses its own
 *     alphabet instead of digits.
 *
 * All four are read here, because "supports KeePass" that only reads one of
 * them is a promise the widget cannot keep.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM = '23456789BCDFGHJKMNPQRTVWXY';

/**
 * RFC 4648 base32, tolerant of spaces, lowercase and missing padding.
 *
 * Deliberately not tolerant of anything else. Sieving the valid letters out of
 * a string that is not base32 at all always succeeds at producing *some* key,
 * and a one-time code from the wrong key is rejected at the far end with no
 * hint as to why.
 */
function base32(input) {
  const raw = String(input == null ? '' : input);
  if (!raw || /[^A-Za-z2-7 =-]/.test(raw)) return null;
  const clean = raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length < 8) return null;

  const out = Buffer.alloc(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const ch of clean) {
    const digit = B32.indexOf(ch);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >>> bits) & 0xff;
    }
  }
  return at ? out.subarray(0, at) : null;
}

const ALGOS = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };

/** What the entry's fields say about its one-time code, or null. */
function readConfig(fields) {
  const get = (name) => {
    const v = fields && (fields.get ? fields.get(name) : fields[name]);
    if (v == null) return null;
    return typeof v === 'string' ? v : v.getText ? v.getText() : String(v);
  };

  const otp = get('otp') || get('OTP') || get('TOTP');
  if (otp && /^otpauth:/i.test(otp.trim())) return fromUri(otp.trim());
  if (otp && /(^|[&?])key=/i.test(otp)) return fromKeeOtp(otp);
  if (otp && base32(otp)) return normalise({ secret: otp });

  const seed = get('TOTP Seed');
  if (seed) return fromTrayTotp(seed, get('TOTP Settings'));

  return null;
}

function fromUri(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // otpauth://totp/Issuer:account?secret=...  — hotp is a counter, not a clock,
  // and a widget cannot advance someone else's counter safely.
  if (!/^totp$/i.test(url.host)) return null;
  const q = url.searchParams;
  return normalise({
    secret: q.get('secret'),
    digits: q.get('digits'),
    period: q.get('period'),
    algorithm: q.get('algorithm'),
    issuer: q.get('issuer'),
  });
}

function fromKeeOtp(text) {
  const q = new URLSearchParams(text.replace(/^.*?\?/, ''));
  return normalise({
    secret: q.get('key'),
    digits: q.get('size'),
    period: q.get('step'),
    algorithm: q.get('otpHashMode'),
  });
}

function fromTrayTotp(seed, settings) {
  const parts = String(settings || '').split(';');
  const steam = parts[1] && parts[1].trim().toUpperCase() === 'S';
  return normalise({
    secret: seed,
    period: parts[0],
    digits: steam ? 5 : parts[1],
    steam,
  });
}

function normalise(raw) {
  const key = base32(raw.secret);
  if (!key) return null;
  const digits = Number(raw.digits);
  const period = Number(raw.period);
  return {
    key,
    digits: Number.isFinite(digits) && digits >= 4 && digits <= 10 ? digits : 6,
    period: Number.isFinite(period) && period > 0 ? period : 30,
    algorithm: ALGOS[String(raw.algorithm || '').toUpperCase()] || 'sha1',
    steam: !!raw.steam,
    issuer: raw.issuer || null,
  };
}

/**
 * The code for a moment in time, and how long it stays good.
 *
 * @param {object} config from readConfig
 * @param {number} [now] milliseconds since the epoch
 */
function code(config, now = Date.now()) {
  if (!config || !config.key) return null;

  const counter = Math.floor(now / 1000 / config.period);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const mac = crypto.createHmac(config.algorithm, config.key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];

  let text;
  if (config.steam) {
    // Steam spends the same number on a 26-letter alphabet rather than digits.
    let left = truncated;
    text = '';
    for (let i = 0; i < config.digits; i++) {
      text += STEAM[left % STEAM.length];
      left = Math.floor(left / STEAM.length);
    }
  } else {
    text = String(truncated % 10 ** config.digits).padStart(config.digits, '0');
  }

  const secondsLeft = config.period - Math.floor(now / 1000) % config.period;
  return { text, secondsLeft, period: config.period };
}

module.exports = { readConfig, code, base32 };
