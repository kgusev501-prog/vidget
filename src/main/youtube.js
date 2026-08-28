'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 12000;
const MAX_RESULTS = 20;

const text = (node) => {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text).join('');
  return '';
};

/**
 * Search without an API key.
 *
 * The Data API needs a key and a quota, which would mean asking the user for
 * one before anything works. The results page ships its payload as a JSON blob
 * in a <script> tag, so we read that instead. It is the page's own data, but
 * the shape is not a contract — hence the defensive walk and a clear error.
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

  const match = /ytInitialData\s*=\s*({.+?});\s*<\/script>/s.exec(html);
  if (!match) return { ok: false, error: 'Не удалось разобрать выдачу YouTube' };

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { ok: false, error: 'Не удалось разобрать выдачу YouTube' };
  }

  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

  const items = [];
  for (const section of sections) {
    for (const entry of section?.itemSectionRenderer?.contents || []) {
      const v = entry.videoRenderer;
      if (!v || !v.videoId) continue;

      const thumbs = v.thumbnail?.thumbnails || [];
      const thumb = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;

      items.push({
        id: v.videoId,
        title: text(v.title) || 'Без названия',
        channel: text(v.ownerText) || text(v.longBylineText),
        duration: text(v.lengthText),
        views: text(v.shortViewCountText),
        live: !!v.badges?.some((b) => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW'),
        thumb,
      });
      if (items.length >= MAX_RESULTS) return { ok: true, items };
    }
  }

  return { ok: true, items };
}

module.exports = { search };
