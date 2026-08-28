'use strict';

/**
 * What kind of thing a copied string is, so the panel can show it sensibly:
 * a link in blue, a colour as a swatch, code in a monospace face.
 */
function classify(text) {
  const t = (text || '').trim();
  if (!t) return 'text';
  if (/^(https?:\/\/|www\.)\S+$/i.test(t) && !/\s/.test(t)) return 'url';
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) return 'color';
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return 'email';
  if (/^[A-Za-z]:\\|^\\\\/.test(t) && t.length < 260 && !t.includes('\n')) return 'path';
  return 'text';
}

module.exports = { classify };
