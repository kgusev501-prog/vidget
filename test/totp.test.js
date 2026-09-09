'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { readConfig, code, base32 } = require('../src/shared/totp');

// The vectors from RFC 6238 itself. A one-time code that is merely plausible is
// worse than none: it is rejected at the other end and the user cannot tell
// whether the fault was theirs.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
// The RFC uses a longer key for each stronger hash, and the vectors only line
// up with the matching one.
const RFC_SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const RFC_SHA512 =
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

test('одноразовый код: совпадает с эталоном RFC 6238', () => {
  const cfg = readConfig({ otp: `otpauth://totp/x?secret=${RFC_SECRET}&digits=8` });
  assert.equal(code(cfg, 59 * 1000).text, '94287082');
  assert.equal(code(cfg, 1111111109 * 1000).text, '07081804');
  assert.equal(code(cfg, 1234567890 * 1000).text, '89005924');
  assert.equal(code(cfg, 2000000000 * 1000).text, '69279037');
});

test('одноразовый код: SHA-256 и SHA-512 берутся из ссылки', () => {
  const sha256 = readConfig({ otp: `otpauth://totp/x?secret=${RFC_SHA256}&digits=8&algorithm=SHA256` });
  assert.equal(sha256.algorithm, 'sha256');
  assert.equal(code(sha256, 59 * 1000).text, '46119246');

  const sha512 = readConfig({ otp: `otpauth://totp/x?secret=${RFC_SHA512}&digits=8&algorithm=SHA512` });
  assert.equal(code(sha512, 59 * 1000).text, '90693936');
});

test('одноразовый код: сколько секунд ему жить', () => {
  const cfg = readConfig({ otp: `otpauth://totp/x?secret=${RFC_SECRET}` });
  assert.equal(code(cfg, 0).secondsLeft, 30, 'на нуле впереди целое окно');
  assert.equal(code(cfg, 29 * 1000).secondsLeft, 1);
  assert.equal(code(cfg, 30 * 1000).secondsLeft, 30, 'следующее окно начинается заново');
});

// Four tools, four places to keep the same secret. A database written by any of
// them has to work, or "поддержка KeePass" is only true for one of them.
test('одноразовый код: читается из ссылки KeePassXC', () => {
  const cfg = readConfig({ otp: `otpauth://totp/GitHub:gus?secret=${RFC_SECRET}&issuer=GitHub&period=60&digits=7` });
  assert.equal(cfg.period, 60);
  assert.equal(cfg.digits, 7);
  assert.equal(cfg.issuer, 'GitHub');
});

test('одноразовый код: читается из строки KeeOtp', () => {
  const cfg = readConfig({ otp: `key=${RFC_SECRET}&size=8&step=60` });
  assert.equal(cfg.digits, 8);
  assert.equal(cfg.period, 60);
  assert.equal(code(cfg, 59 * 1000).text.length, 8);
});

test('одноразовый код: читается из полей KeeTrayTOTP', () => {
  const cfg = readConfig({ 'TOTP Seed': RFC_SECRET, 'TOTP Settings': '60;8' });
  assert.equal(cfg.period, 60);
  assert.equal(cfg.digits, 8);
});

test('одноразовый код: Steam считает буквами, а не цифрами', () => {
  const cfg = readConfig({ 'TOTP Seed': RFC_SECRET, 'TOTP Settings': '30;S' });
  assert.equal(cfg.steam, true);
  assert.equal(cfg.digits, 5);
  assert.match(code(cfg, 59 * 1000).text, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
});

test('одноразовый код: защищённое поле отдаёт свой текст', () => {
  // kdbxweb hands protected values back as objects, not strings.
  const protectedValue = { getText: () => `otpauth://totp/x?secret=${RFC_SECRET}` };
  const cfg = readConfig(new Map([['otp', protectedValue]]));
  assert.ok(cfg);
  assert.equal(code(cfg, 59 * 1000).text, '287082');
});

test('одноразовый код: без секрета ничего не выдумывается', () => {
  assert.equal(readConfig({}), null);
  assert.equal(readConfig({ otp: '' }), null);
  assert.equal(readConfig({ otp: 'otpauth://hotp/x?secret=' + RFC_SECRET }), null, 'счётчик не наш случай');
  assert.equal(readConfig({ otp: 'otpauth://totp/x?secret=не base32 !!!' }), null);
  assert.equal(code(null), null);
});

test('base32: пробелы, регистр и отсутствие набивки не мешают', () => {
  const plain = base32('MZXW6YTBOI');
  assert.equal(plain.toString('utf8'), 'foobar');
  assert.deepEqual(base32('mzxw 6ytb oi'), plain, 'нижний регистр и пробелы — то же самое');
  assert.deepEqual(base32('MZXW6YTBOI======'), plain, 'набивка ничего не добавляет');
  assert.equal(base32('!!!'), null);
});
