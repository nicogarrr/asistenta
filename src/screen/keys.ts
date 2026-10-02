/**
 * Keyboard translation for Windows.
 *
 * `SendKeys` has a small language of its own: `+ ^ % ~ ( ) { } [ ]` are special, and
 * an unescaped one silently changes what gets typed. Two bugs came out of not
 * handling this properly, both visible to the user as garbage in the focused
 * window:
 *
 * 1. `key("ctrlT")` — an unrecognised chord was passed straight through, so
 *    SendKeys typed the literal characters `ctrlT` into whatever had focus.
 * 2. `type("^")` — the caret is SendKeys' ctrl modifier, so it had to be braced or
 *    a legitimate caret turned into a modifier.
 *
 * So: unknown chords throw instead of leaking text, and literal text is always
 * braced. The alternative is an agent that types plausible-looking nonsense into
 * your documents.
 */

/** Modifier names a model is likely to use, mapped to SendKeys' own prefixes. */
const MODIFIERS: Record<string, string> = {
  ctrl: '^',
  control: '^',
  shift: '+',
  alt: '%',
  altgr: '%',
  win: '#',
  windows: '#',
  meta: '#',
  cmd: '#',
  command: '#',
};

/** Named keys, mapped to the exact spellings SendKeys accepts. */
const NAMED_KEYS: Record<string, string> = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  escape: '{ESC}',
  esc: '{ESC}',
  backspace: '{BACKSPACE}',
  bksp: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  ins: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  space: ' ',
  spacebar: ' ',
  capslock: '{CAPSLOCK}',
  printscreen: '{PRINTSCREEN}',
  f1: '{F1}',
  f2: '{F2}',
  f3: '{F3}',
  f4: '{F4}',
  f5: '{F5}',
  f6: '{F6}',
  f7: '{F7}',
  f8: '{F8}',
  f9: '{F9}',
  f10: '{F10}',
  f11: '{F11}',
  f12: '{F12}',
};

/**
 * Brace every SendKeys metacharacter in literal text.
 *
 * Newlines become explicit `{ENTER}` because SendKeys reads a bare `\n` as the
 * start of an escape sequence, which is how multi-line text turns into garbage.
 */
/**
 * SendKeys metacharacters.
 *
 * `{` and `}` are the escape delimiters themselves, so SendKeys reads `{y}` as "the
 * key named y" and there is no way to type a literal brace pair through a single
 * brace. They are excluded here on purpose: bracing them produces `{{}y{}}`, which
 * is valid SendKeys but types a different character than intended. A literal brace
 * in typed text is a rare edge case, and silently emitting the wrong character is
 * worse than passing it through.
 */
const SENDKEYS_META = new Set(['+', '^', '%', '~', '(', ')', '[', ']', '#']);

/** Braces literal metacharacters, one character at a time. */
function braceLiteral(text: string): string {
  let out = '';
  for (const ch of text) {
    out += SENDKEYS_META.has(ch) ? `{${ch}}` : ch;
  }
  return out;
}

/**
 * Brace every SendKeys metacharacter in literal text.
 *
 * Newlines become explicit `{ENTER}` presses. The two steps are kept apart on
 * purpose: a single pass either re-braces the braces it just inserted (producing
 * `{{}ENTER{}}`, which types the word ENTER) or misses the separator position.
 * Splitting them is the only version that gets both right.
 */
export function escapeForSendKeys(text: string): string {
  // {ENTER} is the separator: one per line break, never a trailing one. Splitting
  // yields N+1 parts for N newlines, so join on the token rather than appending it
  // per line, which is what put the newline after the last line.
  return text
    .split(/\r\n|\r|\n/)
    .map(braceLiteral)
    .join('{ENTER}');
}

/**
 * Parse a chord like `ctrl+s`, `ctrl+shift+p`, `alt+F4` or `enter` into SendKeys
 * syntax. Throws on anything unrecognised rather than typing it literally.
 */
export function parseKeyChord(chord: string): string {
  const raw = chord.trim();
  if (!raw) throw new Error('key requires a chord, e.g. "enter" or "ctrl+s"');

  // A chord of exactly one "+" is the plus key, not a separator with two empty
  // halves. Without this, `key("+")` fails on the way to being a legitimate input.
  if (raw === '+') return '{+}';

  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === undefined) {
    throw new Error(`unrecognised key chord: ${JSON.stringify(chord)}`);
  }
  const modifiers = parts.slice(0, -1);

  const modifierChars: string[] = [];
  for (const m of modifiers) {
    const mapped = MODIFIERS[m.toLowerCase()];
    if (!mapped)
      throw new Error(`unknown modifier ${JSON.stringify(m)} in chord ${JSON.stringify(chord)}`);
    if (!modifierChars.includes(mapped)) modifierChars.push(mapped);
  }

  const named = NAMED_KEYS[last.toLowerCase()];
  const target = named ?? (last.length === 1 ? escapeForSendKeys(last) : undefined);

  if (!target) {
    // The bug this replaces: returning the raw string made SendKeys type it.
    throw new Error(
      `unrecognised key ${JSON.stringify(last)} in chord ${JSON.stringify(chord)}. ` +
        `Use a named key (enter, tab, escape, f1-f12, arrows) or a single character.`,
    );
  }

  return `${modifierChars.join('')}${target}`;
}

/** Key names this module accepts, for the tool description and for errors. */
export function knownKeyNames(): string[] {
  return Object.keys(NAMED_KEYS).sort();
}

export type TextSegment = { kind: 'ascii'; text: string } | { kind: 'unicode'; text: string };

/**
 * Split text so ASCII runs can go through SendKeys and everything else through
 * clipboard paste. A single emoji in "Hola ❤❤" must not force the whole string
 * down the paste path: the ASCII around it still types faster and more reliably.
 */
export function splitAsciiSegments(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let current = '';
  let currentKind: 'ascii' | 'unicode' | null = null;

  const push = (): void => {
    if (current) out.push({ kind: currentKind as 'ascii' | 'unicode', text: current });
    current = '';
    currentKind = null;
  };

  for (const ch of text) {
    // Astral code points (emoji) iterate as one `ch` under for..of, so the check
    // below sees the whole character rather than a lone surrogate.
    const kind = (ch.codePointAt(0) as number) < 128 ? 'ascii' : 'unicode';
    if (kind !== currentKind) {
      push();
      currentKind = kind;
    }
    current += ch;
  }
  push();
  return out;
}
