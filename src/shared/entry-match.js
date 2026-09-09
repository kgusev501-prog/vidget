'use strict';

/**
 * Choosing the right entry — by what the user typed, and by the window that is
 * waiting for a password.
 *
 * Both halves are here because both are guesses, and a wrong guess in a
 * password manager is not a cosmetic problem: it types someone else's
 * credentials into a login form. Everything below would rather return nothing
 * than return something plausible.
 */

/** Escapes a string so it can sit inside a regular expression as itself. */
const quote = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);

/**
 * KeePass window patterns: the whole title has to match, `*` stands for any
 * run of characters, and a pattern wrapped in `//` is a regular expression.
 */
function matchesWindow(title, pattern) {
  const text = String(title || '');
  const raw = String(pattern || '').trim();
  if (!raw) return false;

  if (raw.length > 4 && raw.startsWith('//') && raw.endsWith('//')) {
    try {
      return new RegExp(raw.slice(2, -2), 'i').test(text);
    } catch {
      return false; // a pattern that will not compile matches nothing
    }
  }

  const body = raw
    .split('*')
    .map((part) => quote(part))
    .join('.*');
  try {
    return new RegExp('^' + body + '$', 'i').test(text);
  } catch {
    return false;
  }
}

/** The host of a URL, without the www, or null when there is not one. */
function hostOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(/^[a-z][\w+.-]*:/i.test(raw) ? raw : 'https://' + raw);
    const host = parsed.hostname.replace(/^www[.]/i, '').toLowerCase();
    // Anything at all parses as a host name, a Russian word included: it
    // comes back as punycode. Without a dot in it, it is not an address.
    return host && host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

/**
 * How well an entry answers "this is the window in front of you".
 *
 * @param {object} entry a plain summary: {title, url, autoType:{items:[{window}]}}
 * @param {string} windowTitle
 * @returns {{score: number, why: string, sequence: (string|null)}}
 */
function scoreForWindow(entry, windowTitle) {
  const title = String(windowTitle || '');
  if (!title) return { score: 0, why: 'нет окна', sequence: null };

  // An association written by hand in KeePass beats anything guessed. The more
  // specific pattern wins among several, which is what its length stands for.
  const items = (entry.autoType && entry.autoType.items) || [];
  let best = null;
  for (const item of items) {
    if (!item || !matchesWindow(title, item.window)) continue;
    if (!best || String(item.window).length > String(best.window).length) best = item;
  }
  if (best) {
    return {
      score: 100 + Math.min(50, String(best.window).length),
      why: 'окно из настроек записи',
      sequence: best.sequence || null,
    };
  }

  const low = title.toLowerCase();

  const host = hostOf(entry.url);
  if (host && low.includes(host)) return { score: 60, why: 'адрес записи в заголовке', sequence: null };
  // "github.com" in the entry, "GitHub — Chrome" in the title: the name in
  // front of the dot is what a browser actually shows.
  if (host) {
    const name = host.split('.')[0];
    if (name.length > 3 && low.includes(name)) {
      return { score: 45, why: 'имя сайта в заголовке', sequence: null };
    }
  }

  const name = String(entry.title || '').trim().toLowerCase();
  if (name.length > 2 && low.includes(name)) return { score: 40, why: 'название записи в заголовке', sequence: null };

  return { score: 0, why: 'ничего общего с заголовком', sequence: null };
}

/** Entries worth offering for a window, best first; never a bad guess. */
function forWindow(entries, windowTitle) {
  return (entries || [])
    .map((entry) => ({ entry, ...scoreForWindow(entry, windowTitle) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || String(a.entry.title).localeCompare(String(b.entry.title)));
}

const fold = (s) => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е');

/**
 * Free-text search across everything an entry says about itself.
 *
 * Every word has to appear somewhere, so a second word narrows rather than
 * widens. Protected values are never searched: their whole point is not to be
 * held in the open, and the panel does not have them anyway.
 */
function search(entries, query, limit = 60) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return (entries || []).slice(0, limit);

  const hits = [];
  for (const entry of entries || []) {
    const title = fold(entry.title);
    const user = fold(entry.user);
    const url = fold(entry.url);
    const group = fold(entry.group);
    const tags = fold((entry.tags || []).join(' '));
    const extra = fold((entry.fieldNames || []).join(' ')) + ' ' + fold(entry.notes);
    const haystack = [title, user, url, group, tags, extra].join(' ');

    if (!words.every((w) => haystack.includes(w))) continue;

    let score = 0;
    for (const w of words) {
      if (title.startsWith(w)) score += 100;
      else if (title.includes(w)) score += 70;
      if (user.includes(w)) score += 50;
      if (url.includes(w)) score += 40;
      if (group.includes(w) || tags.includes(w)) score += 25;
      if (extra.includes(w)) score += 10;
    }
    hits.push({ entry, score });
  }

  return hits
    .sort((a, b) => b.score - a.score || String(a.entry.title).localeCompare(String(b.entry.title)))
    .slice(0, limit)
    .map((h) => h.entry);
}

module.exports = { matchesWindow, hostOf, scoreForWindow, forWindow, search };
