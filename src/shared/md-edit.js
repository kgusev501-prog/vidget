'use strict';

/**
 * Editing moves for Markdown notes, as pure functions over text and a
 * selection, so the textarea of the quick note and the live editor share them
 * and they can be tested without a window.
 *
 * Each takes the text and selection offsets and returns the new text with
 * where the selection should be.
 */

const LIST = /^(\s*)(?:([-*+])(\s+)\[([ xXхХ])\](\s+|$)|([-*+])(\s+)|(\d{1,9})([.)])(\s+))/;

function lineAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end < 0) end = text.length;
  return { start, end, line: text.slice(start, end) };
}

const replace = (text, start, end, insert) => text.slice(0, start) + insert + text.slice(end);

/**
 * Shift+Enter: a new line that carries the list on.
 *
 * In a list item the next line starts with the same marker — the next number,
 * an unticked box. On an item with nothing after its marker the marker is
 * taken away instead, so pressing twice in a row ends the list with a plain
 * line, the way every editor with lists behaves.
 */
function newLine(text, selStart, selEnd = selStart) {
  const { start, line } = lineAt(text, selStart);
  const m = LIST.exec(line);
  const before = text.slice(start, selStart);

  if (m && selStart === selEnd) {
    const marker = m[0];
    const content = line.slice(marker.length);
    // An empty item, caret at its end: leave the list.
    if (!content.trim() && before.length >= marker.length) {
      const next = replace(text, start, start + line.length, '');
      return { text: next, start, end: start };
    }
    if (before.length >= marker.length) {
      const indent = m[1];
      let carry;
      if (m[2]) carry = `${indent}${m[2]}${m[3]}[ ]${m[5] || ' '}`;
      else if (m[6]) carry = `${indent}${m[6]}${m[7]}`;
      else carry = `${indent}${Number(m[8]) + 1}${m[9]}${m[10]}`;
      const insert = `\n${carry}`;
      const pos = selStart + insert.length;
      return { text: replace(text, selStart, selEnd, insert), start: pos, end: pos };
    }
  }

  const pos = selStart + 1;
  return { text: replace(text, selStart, selEnd, '\n'), start: pos, end: pos };
}

/** How many of `ch` run leftwards from `pos` (exclusive) and rightwards from `end`. */
function runs(text, start, end, ch) {
  let left = 0;
  while (start - left - 1 >= 0 && text[start - left - 1] === ch) left += 1;
  let right = 0;
  while (end + right < text.length && text[end + right] === ch) right += 1;
  return { left, right };
}

/**
 * Ctrl+B / Ctrl+I: wrap the selection in the markup, or take it off again.
 *
 * With nothing selected, a pair is inserted and the caret put between them.
 * Italic with `*` has to tell itself apart from bold `**`: a run of one or
 * three stars round the selection is italic, two is only bold.
 */
function toggleWrap(text, selStart, selEnd, mark) {
  const size = mark.length;
  const single = mark === '*' || mark === '_';

  if (selStart === selEnd) {
    const around = runs(text, selStart, selEnd, mark[0]);
    // Caret sitting in an empty pair it just made: take the pair away.
    if (around.left >= size && around.right >= size && (!single || (around.left !== 2 && around.right !== 2))) {
      const next = text.slice(0, selStart - size) + text.slice(selEnd + size);
      return { text: next, start: selStart - size, end: selStart - size };
    }
    const pos = selStart + size;
    return { text: replace(text, selStart, selEnd, mark + mark), start: pos, end: pos };
  }

  const selected = text.slice(selStart, selEnd);
  const around = runs(text, selStart, selEnd, mark[0]);
  const wrappedOutside = single
    ? (around.left === 1 || around.left === 3) && (around.right === 1 || around.right === 3)
    : around.left >= size && around.right >= size;
  if (wrappedOutside) {
    const next = text.slice(0, selStart - size) + selected + text.slice(selEnd + size);
    return { text: next, start: selStart - size, end: selEnd - size };
  }

  const inside = selected.length > size * 2 && selected.startsWith(mark) && selected.endsWith(mark);
  const insideIsOurs = !single || (!selected.startsWith(mark.repeat(2)) || selected.startsWith(mark.repeat(3)));
  if (inside && insideIsOurs) {
    const inner = selected.slice(size, selected.length - size);
    return { text: replace(text, selStart, selEnd, inner), start: selStart, end: selStart + inner.length };
  }

  // Spaces at the edges of a selection stay outside the markup, or it would
  // not count as markup at all.
  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  const core = selected.trim();
  if (!core) return { text, start: selStart, end: selEnd };
  const wrapped = selected.slice(0, lead) + mark + core + mark + selected.slice(selected.length - trail);
  return {
    text: replace(text, selStart, selEnd, wrapped),
    start: selStart + lead + size,
    end: selStart + lead + size + core.length,
  };
}

/** Ticks or unticks the task box on one line; any other line is left alone. */
function toggleTask(text, lineIndex) {
  const lines = String(text).split('\n');
  const line = lines[lineIndex];
  if (line == null) return text;
  const m = /^(\s*[-*+]\s+\[)([ xXхХ])(\])/.exec(line);
  if (!m) return text;
  lines[lineIndex] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3] + line.slice(m[0].length);
  return lines.join('\n');
}

module.exports = { newLine, toggleWrap, toggleTask, lineAt };
