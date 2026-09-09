'use strict';

/**
 * KeePass auto-type sequences, turned into a list of things to do.
 *
 * An entry can carry its own sequence — "{USERNAME}{TAB}{PASSWORD}{ENTER}" is
 * only the default — and databases in the wild use the full vocabulary: key
 * names, modifiers, delays, custom fields. Reading a sequence and quietly
 * dropping the parts we did not implement would type the wrong thing into a
 * login form, so anything unrecognised stops the whole sequence instead.
 *
 * Field values are deliberately *not* filled in here. This runs on a plain
 * string and hands back placeholders; the passwords are put in at the last
 * possible moment, by the one process that is allowed to hold them.
 */

// The sequence names on the left are what KeePass writes; the values are what
// the sidecar knows how to press.
const KEYS = {
  TAB: 'TAB',
  ENTER: 'ENTER',
  '~': 'ENTER',
  SPACE: 'SPACE',
  BACKSPACE: 'BACKSPACE',
  BS: 'BACKSPACE',
  BKSP: 'BACKSPACE',
  DELETE: 'DELETE',
  DEL: 'DELETE',
  INSERT: 'INSERT',
  INS: 'INSERT',
  HOME: 'HOME',
  END: 'END',
  PGUP: 'PGUP',
  PGDN: 'PGDN',
  UP: 'UP',
  DOWN: 'DOWN',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  ESC: 'ESC',
  ESCAPE: 'ESC',
  CAPSLOCK: 'CAPSLOCK',
  NUMLOCK: 'NUMLOCK',
  PRTSC: 'PRTSC',
  BREAK: 'BREAK',
  APPS: 'APPS',
  WIN: 'LWIN',
  LWIN: 'LWIN',
  RWIN: 'RWIN',
  ADD: 'ADD',
  SUBTRACT: 'SUBTRACT',
  MULTIPLY: 'MULTIPLY',
  DIVIDE: 'DIVIDE',
};
for (let i = 1; i <= 16; i++) KEYS[`F${i}`] = `F${i}`;
for (let i = 0; i <= 9; i++) KEYS[`NUMPAD${i}`] = `NUMPAD${i}`;

// Placeholders that stand for something on the entry.
const FIELDS = {
  USERNAME: 'UserName',
  PASSWORD: 'Password',
  URL: 'URL',
  TITLE: 'Title',
  NOTES: 'Notes',
};

// Characters that mean a modifier rather than themselves, and the braces that
// let a sequence type one of them literally.
const MODS = { '+': 'shift', '^': 'ctrl', '%': 'alt' };
const LITERAL = { '{': '{', '}': '}', '+': '+', '^': '^', '%': '%', '(': '(', ')': ')', ' ': ' ' };

const DEFAULT_SEQUENCE = '{USERNAME}{TAB}{PASSWORD}{ENTER}';

class SequenceError extends Error {}

/**
 * @param {string} sequence
 * @returns {Array<object>} actions: {type:'text'}, {type:'field'}, {type:'key'},
 *          {type:'delay'}, {type:'rate'}, {type:'clear'}
 */
function parse(sequence) {
  const src = String(sequence == null ? '' : sequence);
  const out = [];
  let text = '';
  let pending = []; // modifiers waiting for something to apply to

  const flush = () => {
    if (text) out.push({ type: 'text', value: text });
    text = '';
  };

  /** A modifier before a group applies to every key inside it. */
  const emitKey = (key) => {
    flush();
    out.push(pending.length ? { type: 'key', key, mods: pending.slice() } : { type: 'key', key });
  };

  const emitChar = (ch) => {
    if (!pending.length) {
      text += ch;
      return;
    }
    flush();
    out.push({ type: 'key', key: `CHAR:${ch}`, mods: pending.slice() });
  };

  let i = 0;
  let groupMods = null;

  while (i < src.length) {
    const ch = src[i];

    if (MODS[ch]) {
      pending.push(MODS[ch]);
      i += 1;
      continue;
    }

    if (ch === '(') {
      // "+(abc)" holds Shift down for the whole group.
      groupMods = pending.slice();
      pending = groupMods.slice();
      i += 1;
      continue;
    }

    if (ch === ')') {
      groupMods = null;
      pending = [];
      i += 1;
      continue;
    }

    if (ch === '{') {
      const end = src.indexOf('}', i + 1);
      // "{}}" types a closing brace: the placeholder is empty and the brace
      // that ends it is the next character along.
      const raw = end < 0 ? null : src.slice(i + 1, end);
      if (raw === null) throw new SequenceError(`не закрыта скобка в «${src.slice(i, i + 12)}»`);

      const token = raw.length ? raw : src[i + 2] === '}' ? '}' : '';
      const step = raw.length ? end - i + 1 : 3;

      const decided = token.toUpperCase();

      if (LITERAL[token] !== undefined) emitChar(LITERAL[token]);
      else if (KEYS[decided]) emitKey(KEYS[decided]);
      else if (FIELDS[decided]) {
        flush();
        out.push({ type: 'field', field: FIELDS[decided] });
      } else if (decided === 'TOTP' || decided === 'TOTP-6' || decided === 'TOTP-8') {
        flush();
        out.push({ type: 'field', field: 'TOTP' });
      } else if (decided === 'CLEARFIELD') {
        flush();
        out.push({ type: 'clear' });
      } else if (/^S:/i.test(token)) {
        flush();
        out.push({ type: 'field', field: token.slice(2), custom: true });
      } else if (/^DELAY[ =]/i.test(token)) {
        const ms = Number(token.slice(6).trim());
        if (!Number.isFinite(ms) || ms < 0) throw new SequenceError(`непонятная задержка «${token}»`);
        flush();
        // "{DELAY=x}" sets the pace of every later keystroke; "{DELAY x}" waits
        // once, right here.
        out.push(token[5] === '=' ? { type: 'rate', ms } : { type: 'delay', ms });
      } else {
        throw new SequenceError(`неизвестная вставка «{${token}}»`);
      }

      if (!groupMods) pending = [];
      i += step;
      continue;
    }

    emitChar(ch);
    if (!groupMods) pending = [];
    i += 1;
  }

  flush();
  if (pending.length && !groupMods) throw new SequenceError('модификатор в конце строки ни к чему не относится');
  return out;
}

/** True when a sequence can be carried out as written. */
function check(sequence) {
  try {
    parse(sequence);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { parse, check, DEFAULT_SEQUENCE, SequenceError, KEYS, FIELDS };
