'use strict';

const crypto = require('crypto');

/**
 * Making up a password.
 *
 * Two things matter and both are easy to get wrong. The randomness has to come
 * from the system, not from Math.random, which is predictable to anyone who
 * cares. And picking a character by taking a random byte modulo the alphabet
 * size quietly favours the first few letters whenever the alphabet does not
 * divide 256 — so bytes that would skew the result are thrown away instead.
 */

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&*+-=?@^_~',
};

// The characters people misread when copying a password off the screen.
const AMBIGUOUS = new Set(['I', 'l', '1', 'O', '0', 'o']);

const DEFAULTS = { length: 20, lower: true, upper: true, digits: true, symbols: true, readable: false };

/** One character of the alphabet, without the bias that modulo would add. */
function pick(alphabet) {
  const limit = 256 - (256 % alphabet.length);
  for (;;) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) return alphabet[byte % alphabet.length];
  }
}

function alphabetFor(options) {
  let alphabet = '';
  for (const name of ['lower', 'upper', 'digits', 'symbols']) {
    if (options[name]) alphabet += SETS[name];
  }
  if (options.readable) alphabet = [...alphabet].filter((c) => !AMBIGUOUS.has(c)).join('');
  return alphabet;
}

/**
 * @param {object} [options] length and which kinds of character to use
 * @returns {string}
 */
function generate(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const length = Math.max(4, Math.min(128, Math.round(Number(settings.length) || DEFAULTS.length)));

  const alphabet = alphabetFor(settings);
  // Every box unticked would otherwise mean an empty alphabet and no password
  // at all; letters are the least surprising thing to fall back to.
  const pool = alphabet || alphabetFor({ ...settings, lower: true, upper: true });

  const groups = ['lower', 'upper', 'digits', 'symbols']
    .filter((name) => settings[name])
    .map((name) => (settings.readable ? [...SETS[name]].filter((c) => !AMBIGUOUS.has(c)).join('') : SETS[name]))
    .filter(Boolean);

  const out = [];
  // At least one of each kind that was asked for, so a site that demands a
  // digit does not send the user back to press the button again.
  for (const group of groups.slice(0, length)) out.push(pick(group));
  while (out.length < length) out.push(pick(pool));

  // Those first characters are in a fixed order; shuffle so the shape of the
  // password says nothing about how it was built.
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

module.exports = { generate, SETS, AMBIGUOUS, DEFAULTS };
