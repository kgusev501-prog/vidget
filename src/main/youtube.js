'use strict';

const { parseSearch } = require('../shared/parse-youtube');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

/**
 * Search without an API key.
 *
 * The Data API needs a key and a quota, which would mean asking the user for
 * one before anything works. The results page ships its payload as a JSON blob
 * in a <script> tag, so we read that instead.
 */
async function search(query) {
  const q = (query || '').trim();
  if (!q) return { ok: true, items: [] };

  let html;
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=ru`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.9' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return { ok: false, error: `YouTube ответил ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'YouTube не ответил' : 'Нет связи с YouTube' };
  }

  const items = parseSearch(html);
  if (!items) return { ok: false, error: 'Не удалось разобрать выдачу YouTube' };
  return { ok: true, items };
}

module.exports = { search };
