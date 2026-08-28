// Generates the tray icon: a small pull-down tab, white on transparent.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function png(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const put = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = a;
  };

  const w = Math.round(size * 0.78);
  const h = Math.round(size * 0.44);
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round(size * 0.16);
  const r = Math.round(h * 0.5);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // rounded rectangle mask
      const dx = Math.max(r - x, x - (w - 1 - r), 0);
      const dy = Math.max(r - y, y - (h - 1 - r), 0);
      if (dx * dx + dy * dy > r * r) continue;
      const edge = x < 1 || x > w - 2 || y < 1 || y > h - 2;
      put(x0 + x, y0 + y, edge ? 180 : 235);
    }
  }
  // the grab line inside
  const ly = y0 + Math.round(h / 2);
  for (let x = x0 + Math.round(w * 0.28); x < x0 + Math.round(w * 0.72); x++) put(x, ly, 90);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'tray.png'), png(32));
fs.writeFileSync(path.join(dir, 'icon-256.png'), png(256));
console.log('icons written to', dir);
