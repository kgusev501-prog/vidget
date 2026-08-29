'use strict';

const zlib = require('zlib');

/**
 * A small lossless PNG encoder.
 *
 * Electron has one built in, but it only exists where `nativeImage` does — the
 * main process. Encoding a screenshot there blocks everything the widget does,
 * and a 48-megapixel photo blocks it for over a second. A utility process gets
 * `net` and `systemPreferences` and nothing else, so to move the work off the
 * main thread the encoder has to be ours. zlib is built into Node, and PNG is
 * lossless at every compression level: nothing about the picture is given up.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4; // RGBA

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.allocUnsafe(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * Windows hands pixels over as BGRA; PNG wants RGBA. Swapped in place, because
 * the buffer is tens of megabytes and a second copy of it is the thing we are
 * trying to avoid.
 */
function bgraToRgba(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = b;
  }
  return buf;
}

/**
 * Applies the Sub filter to every row: each byte becomes its difference from
 * the pixel to its left. Cheap to compute and it lets zlib do far better on
 * photographs and screenshots than storing rows unfiltered.
 */
function filterRows(rgba, width, height) {
  const stride = width * BYTES_PER_PIXEL;
  const out = Buffer.allocUnsafe((stride + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    out[o++] = 1; // filter type: Sub
    for (let x = 0; x < BYTES_PER_PIXEL; x++) out[o++] = rgba[row + x];
    for (let x = BYTES_PER_PIXEL; x < stride; x++) {
      out[o++] = (rgba[row + x] - rgba[row + x - BYTES_PER_PIXEL]) & 0xff;
    }
  }
  return out;
}

/**
 * @param {Buffer} rgba   width*height*4 bytes, RGBA order
 * @param {number} width
 * @param {number} height
 * @param {{level?: number}} [options]  zlib level; 6 is the default trade
 * @returns {Buffer} a complete PNG file
 */
function encode(rgba, width, height, options = {}) {
  if (!width || !height) throw new Error('png: empty image');
  const expected = width * height * BYTES_PER_PIXEL;
  if (rgba.length !== expected) {
    throw new Error(`png: expected ${expected} bytes for ${width}x${height}, got ${rgba.length}`);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = zlib.deflateSync(filterRows(rgba, width, height), {
    level: options.level == null ? 6 : options.level,
  });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Reads width and height out of a PNG header without decoding the pixels. */
function readSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = { encode, readSize, bgraToRgba, crc32, SIGNATURE };
