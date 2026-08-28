'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'renderer');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Serves the panel over http://127.0.0.1:<random>.
 *
 * A file:// page has a null origin, and YouTube refuses to embed a player for
 * one — the iframe comes back as "video unavailable". Served from loopback the
 * page has a real origin, which is what the embed API expects.
 *
 * Loopback only, random port, and it serves nothing outside the renderer folder.
 */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Bound to loopback already; refuse anything addressed by another name so
      // a stray request from elsewhere cannot reach the panel's files.
      const host = (req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') {
        res.writeHead(403).end();
        return;
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);

      // Never step outside the renderer folder, whatever the request says.
      if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
        res.writeHead(403).end();
        return;
      }

      fs.readFile(file, (err, body) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    });

    server.on('error', (err) => {
      console.error('[server]', err.message);
      resolve(null);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { startServer };
