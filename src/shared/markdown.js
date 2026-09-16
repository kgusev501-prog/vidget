'use strict';

/**
 * Markdown for the notes, read line by line.
 *
 * The notes editor shows formatting as you type and hides the markup on every
 * line but the one being edited. For that to work the raw text must stay the
 * single source of truth: every line is cut into pieces that, put back
 * together, give exactly the characters typed — markup included. The editor
 * then only decides which pieces to show; it never rewrites what was written,
 * and the caret can always be found again by counting characters.
 *
 * Deliberately a small dialect: what people actually put in a quick note.
 * Headings, bold, italic, strike, inline code, links, bullet and numbered
 * lists, task boxes, quotes, rules and fenced code. No HTML ever comes out of
 * here — only plain objects the panel turns into elements — so nothing typed
 * into a note can inject markup into the panel.
 */

const FENCE = /^(\s*)(```|~~~)(.*)$/;
const HEADING = /^(#{1,6})(\s+)/;
const TASK = /^(\s*)([-*+])(\s+)\[([ xXхХ])\](\s+|$)/;
const BULLET = /^(\s*)([-*+])(\s+)/;
const ORDERED = /^(\s*)(\d{1,9})([.)])(\s+)/;
const QUOTE = /^(\s*)(>\s?)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Inline pieces of a stretch of text.
 *
 * @returns {{text: string, mark?: boolean, styles: string[], href?: string}[]}
 *   `mark` pieces are the markup itself (`**`, `](url)`…); the rest is what
 *   the markup applies to. Joined, the `text` of all pieces is the input.
 */
function inline(source, styles = []) {
  const out = [];
  const push = (text, extra = {}) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Neighbouring plain pieces with the same styles are one piece.
    if (last && !last.mark && !extra.mark && !extra.href && !last.href && same(last.styles, styles)) {
      last.text += text;
      return;
    }
    out.push({ text, styles: styles.slice(), ...extra });
  };

  let rest = source;
  while (rest) {
    const hit = nextInline(rest);
    if (!hit) {
      push(rest);
      break;
    }
    push(rest.slice(0, hit.index));

    if (hit.kind === 'code') {
      out.push({ text: hit.open, mark: true, styles: styles.slice() });
      out.push({ text: hit.inner, styles: [...styles, 'code'] });
      out.push({ text: hit.close, mark: true, styles: styles.slice() });
    } else if (hit.kind === 'link') {
      out.push({ text: '[', mark: true, styles: styles.slice() });
      for (const piece of inline(hit.inner, [...styles, 'link'])) out.push({ ...piece, href: hit.href });
      out.push({ text: hit.close, mark: true, styles: styles.slice(), href: hit.href });
    } else {
      out.push({ text: hit.open, mark: true, styles: styles.slice() });
      for (const piece of inline(hit.inner, [...styles, hit.kind])) out.push(piece);
      out.push({ text: hit.close, mark: true, styles: styles.slice() });
    }
    rest = rest.slice(hit.index + hit.length);
  }
  return out;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The earliest inline construct in a string, if any. */
function nextInline(s) {
  const candidates = [];
  const find = (kind, re, build) => {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m) candidates.push({ kind, index: m.index, length: m[0].length, ...build(m) });
  };

  find('code', /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => ({ open: m[1], inner: m[2], close: m[1] }));
  find('link', /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (m) => ({
    inner: m[1],
    href: m[2],
    close: `](${m[2]})`,
  }));
  // Bold closes on the last two of a run of stars, so **bold *italic*** keeps
  // its italic inside rather than ending the bold one star too early.
  find('b', /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/g, (m) => ({ open: '**', inner: m[1], close: '**' }));
  find('b', /__(?=\S)([\s\S]*?\S)__(?!_)/g, (m) => ({ open: '__', inner: m[1], close: '__' }));
  find('s', /(~~)(?=\S)([\s\S]*?\S)~~/g, (m) => ({ open: m[1], inner: m[2], close: m[1] }));
  // Single * for italic, but not the halves of a ** pair; _ only between
  // non-word characters, so snake_case_names stay as they are.
  find('i', /(?<!\*)\*(?!\*)(?=\S)([^*]*?\S)\*(?!\*)/g, (m) => ({ open: '*', inner: m[1], close: '*' }));
  find('i', /(?<![\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, (m) => ({ open: '_', inner: m[1], close: '_' }));

  if (!candidates.length) return null;
  // Earliest wins; at the same place, code first — nothing inside code is markup.
  const order = { code: 0, link: 1, b: 2, s: 3, i: 4 };
  candidates.sort((a, b) => a.index - b.index || order[a.kind] - order[b.kind]);
  return candidates[0];
}

/**
 * One line, knowing whether it sits inside a fenced code block.
 *
 * @returns {{
 *   kind: 'blank'|'text'|'heading'|'bullet'|'ordered'|'task'|'quote'|'rule'|'fence'|'code',
 *   raw: string, indent: string, marker: string, level?: number,
 *   number?: number, checked?: boolean, segments: object[]
 * }}
 */
function parseLine(raw, inFence = false) {
  const base = { raw, indent: '', marker: '' };

  if (FENCE.test(raw)) return { ...base, kind: 'fence', segments: [{ text: raw, mark: true, styles: [] }] };
  if (inFence) return { ...base, kind: 'code', segments: raw ? [{ text: raw, styles: ['code'] }] : [] };
  if (!raw.trim()) return { ...base, kind: 'blank', segments: raw ? [{ text: raw, styles: [] }] : [] };
  if (RULE.test(raw)) return { ...base, kind: 'rule', segments: [{ text: raw, mark: true, styles: [] }] };

  let m = HEADING.exec(raw);
  if (m) {
    const marker = m[1] + m[2];
    return { ...base, kind: 'heading', level: m[1].length, marker, segments: inline(raw.slice(marker.length)) };
  }

  m = TASK.exec(raw);
  if (m) {
    const marker = `${m[2]}${m[3]}[${m[4]}]${m[5]}`;
    return {
      ...base,
      kind: 'task',
      indent: m[1],
      marker,
      checked: m[4] !== ' ',
      segments: inline(raw.slice(m[1].length + marker.length)),
    };
  }

  m = ORDERED.exec(raw);
  if (m) {
    const marker = m[2] + m[3] + m[4];
    return {
      ...base,
      kind: 'ordered',
      indent: m[1],
      marker,
      number: Number(m[2]),
      segments: inline(raw.slice(m[1].length + marker.length)),
    };
  }

  m = BULLET.exec(raw);
  if (m) {
    const marker = m[2] + m[3];
    return { ...base, kind: 'bullet', indent: m[1], marker, segments: inline(raw.slice(m[1].length + marker.length)) };
  }

  m = QUOTE.exec(raw);
  if (m) {
    return { ...base, kind: 'quote', indent: m[1], marker: m[2], segments: inline(raw.slice(m[1].length + m[2].length)) };
  }

  return { ...base, kind: 'text', segments: inline(raw) };
}

/** Every line of a note, fenced code taken into account. */
function parse(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let inFence = false;
  for (const raw of lines) {
    const line = parseLine(raw, inFence);
    if (line.kind === 'fence') inFence = !inFence;
    out.push(line);
  }
  return out;
}

/** What a line says with the markup taken away — a note's title, a search hit. */
function plainLine(raw) {
  const line = parseLine(raw);
  if (line.kind === 'rule' || line.kind === 'fence') return '';
  return line.segments
    .filter((s) => !s.mark)
    .map((s) => s.text)
    .join('')
    .trim();
}

module.exports = { parse, parseLine, inline, plainLine };
