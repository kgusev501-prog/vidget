'use strict';

const fs = require('fs');
const path = require('path');

const { encode, bgraToRgba } = require('../shared/png');

/**
 * Encodes clipboard pictures to PNG, away from the main process.
 *
 * A utility process has no `nativeImage`, so the encoder is our own — see
 * ../shared/png.js. Everything here is lossless: the file holds exactly the
 * pixels Windows put on the clipboard.
 */
process.parentPort.on('message', (event) => {
  const job = event.data;
  if (!job || job.type !== 'encode') return;

  const reply = (msg) => {
    try {
      process.parentPort.postMessage({ id: job.id, ...msg });
    } catch {
      /* the parent went away; nothing to report to */
    }
  };

  try {
    // Windows hands the pixels over as BGRA. Swapped in place: the buffer
    // arrived as a copy already and is tens of megabytes.
    const png = encode(bgraToRgba(job.bitmap), job.width, job.height, { level: job.level });
    const tmp = `${job.file}.part`;
    fs.mkdirSync(path.dirname(job.file), { recursive: true });
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, job.file);
    reply({ ok: true, bytes: png.length });
  } catch (err) {
    reply({ ok: false, message: (err && err.message) || 'encode failed' });
  }
});
