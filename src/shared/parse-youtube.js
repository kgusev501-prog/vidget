'use strict';

const MAX_RESULTS = 20;

const text = (node) => {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text).join('');
  return '';
};

/**
 * Reads the search results out of a YouTube results page.
 *
 * The page ships its own payload as a JSON blob in a <script> tag, which is
 * what the site itself renders from. The shape is not a contract, so every step
 * is optional-chained and a miss returns nothing rather than throwing.
 */
function parseSearch(html) {
  const match = /ytInitialData\s*=\s*({.+?});\s*<\/script>/s.exec(html || '');
  if (!match) return null;

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

  const items = [];
  for (const section of sections) {
    for (const entry of section?.itemSectionRenderer?.contents || []) {
      const v = entry.videoRenderer;
      if (!v || !v.videoId) continue;

      const thumbs = v.thumbnail?.thumbnails || [];
      items.push({
        id: v.videoId,
        title: text(v.title) || 'Без названия',
        channel: text(v.ownerText) || text(v.longBylineText),
        duration: text(v.lengthText),
        views: text(v.shortViewCountText),
        live: !!v.badges?.some((b) => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW'),
        thumb: thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      });
      if (items.length >= MAX_RESULTS) return items;
    }
  }
  return items;
}

module.exports = { parseSearch };
