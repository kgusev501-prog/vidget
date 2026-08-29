'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { encode, readSize, bgraToRgba, crc32, SIGNATURE } = require('../src/shared/png');

/** Pulls the chunks back out of a PNG so the tests can look inside. */
function chunks(buf) {
  const out = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    const crc = buf.readUInt32BE(o + 8 + len);
    out.push({ type, data, crc, declared: len });
    o += 12 + len;
  }
  return out;
}

/** Undoes the Sub filter, giving the original rows back. */
function unfilter(raw, width, height) {
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[o++];
    assert.strictEqual(type, 1, 'rows are written with the Sub filter');
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? out[row + x - 4] : 0;
      out[row + x] = (raw[o++] + left) & 0xff;
    }
  }
  return out;
}

const solid = (w, h, [r, g, b, a]) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
  return buf;
};

test('produces a file that starts with the PNG signature', () => {
  const png = encode(solid(4, 4, [10, 20, 30, 255]), 4, 4);
  assert.ok(png.subarray(0, 8).equals(SIGNATURE));
});

test('writes IHDR, IDAT and IEND in that order', () => {
  const types = chunks(encode(solid(2, 2, [1, 2, 3, 255]), 2, 2)).map((c) => c.type);
  assert.deepStrictEqual(types, ['IHDR', 'IDAT', 'IEND']);
});

test('IHDR describes an 8-bit RGBA image of the right size', () => {
  const [ihdr] = chunks(encode(solid(7, 3, [0, 0, 0, 255]), 7, 3));
  assert.strictEqual(ihdr.data.readUInt32BE(0), 7);
  assert.strictEqual(ihdr.data.readUInt32BE(4), 3);
  assert.strictEqual(ihdr.data[8], 8, 'bit depth');
  assert.strictEqual(ihdr.data[9], 6, 'colour type: truecolour with alpha');
  assert.strictEqual(ihdr.data[10], 0, 'deflate');
  assert.strictEqual(ihdr.data[12], 0, 'not interlaced');
});

test('every chunk carries a correct CRC', () => {
  for (const c of chunks(encode(solid(5, 5, [9, 8, 7, 255]), 5, 5))) {
    const head = Buffer.from(c.type, 'ascii');
    assert.strictEqual(crc32(Buffer.concat([head, c.data])), c.crc, `${c.type} checksum`);
  }
});

test('the pixels survive the round trip exactly — nothing is lost', () => {
  const w = 9;
  const h = 5;
  const original = Buffer.alloc(w * h * 4);
  for (let i = 0; i < original.length; i++) original[i] = (i * 37 + 11) & 0xff;

  const png = encode(Buffer.from(original), w, h);
  const idat = chunks(png).find((c) => c.type === 'IDAT');
  const back = unfilter(zlib.inflateSync(idat.data), w, h);

  assert.ok(back.equals(original), 'decoded pixels match the ones handed in');
});

test('a single row and a single column both work', () => {
  for (const [w, h] of [[1, 1], [1, 40], [40, 1]]) {
    const src = Buffer.alloc(w * h * 4, 0x5a);
    const png = encode(Buffer.from(src), w, h);
    const idat = chunks(png).find((c) => c.type === 'IDAT');
    assert.ok(unfilter(zlib.inflateSync(idat.data), w, h).equals(src), `${w}x${h}`);
  }
});

test('refuses a buffer that does not match the stated size', () => {
  assert.throws(() => encode(Buffer.alloc(10), 4, 4), /expected 64 bytes/);
});

test('refuses an empty image rather than writing a broken file', () => {
  assert.throws(() => encode(Buffer.alloc(0), 0, 0), /empty image/);
});

test('readSize reports the dimensions without decoding', () => {
  assert.deepStrictEqual(readSize(encode(solid(320, 200, [0, 0, 0, 255]), 320, 200)), {
    width: 320,
    height: 200,
  });
});

test('readSize refuses anything that is not a PNG', () => {
  assert.strictEqual(readSize(Buffer.from('not a picture at all, really')), null);
  assert.strictEqual(readSize(Buffer.alloc(4)), null);
});

test('bgraToRgba swaps the blue and red channels and leaves alpha alone', () => {
  const bgra = Buffer.from([255, 0, 0, 200, 0, 0, 255, 100]);
  const rgba = bgraToRgba(bgra);
  assert.deepStrictEqual([...rgba], [0, 0, 255, 200, 255, 0, 0, 100]);
});

test('bgraToRgba works in place, so a big picture is not copied twice', () => {
  const buf = Buffer.from([1, 2, 3, 4]);
  assert.strictEqual(bgraToRgba(buf), buf);
});

test('bgraToRgba applied twice gives the original back', () => {
  const original = Buffer.from([11, 22, 33, 44, 55, 66, 77, 88]);
  const buf = Buffer.from(original);
  assert.ok(bgraToRgba(bgraToRgba(buf)).equals(original));
});

test('a flat picture compresses far below its raw size', () => {
  const w = 200;
  const h = 200;
  const png = encode(solid(w, h, [128, 128, 128, 255]), w, h);
  assert.ok(png.length < w * h * 4 * 0.05, `expected real compression, got ${png.length} bytes`);
});
