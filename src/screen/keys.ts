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
  pgup: '{PGUP}',
  pgdn: '{PGDN}',
  arrowup: '{UP}',
  arrowdown: '{DOWN}',
  arrowleft: '{LEFT}',
  arrowright: '{RIGHT}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  space: ' ',
  spacebar: ' ',
  capslock: '{CAPSLOCK}',
  numlock: '{NUMLOCK}',
  scrolllock: '{SCROLLLOCK}',
  // SendKeys' own word is PRTSC: «{PRINTSCREEN}» is not one of its keywords, so
  // SendWait threw and «printscreen» failed every time on Windows.
  printscreen: '{PRTSC}',
  prtsc: '{PRTSC}',
  prtscn: '{PRTSC}',
  plus: '{+}',
  minus: '-',
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
  // SendKeys goes up to F16; F17-F24 only exist through real key events (win+…).
  f13: '{F13}',
  f14: '{F14}',
  f15: '{F15}',
  f16: '{F16}',
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
 * worse than passing it through. `WindowsScreen.type` never sends them here anyway:
 * `splitAsciiSegments` routes braces to the paste path.
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
 * One key character in SendKeys syntax. Braces themselves must be written `{{}` and
 * `{}}`; a bare `{` used to reach SendKeys as is and it threw instead of pressing it.
 */
function braceKey(ch: string): string {
  if (ch === '{' || ch === '}') return `{${ch}}`;
  return escapeForSendKeys(ch);
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
  // «ctrl++» (zoom in) splits into ['ctrl'] once the empty pieces are dropped,
  // which used to be refused as «unrecognised key "ctrl"». A chord that ends in
  // two '+' means the '+' key itself after the modifiers.
  if (/\+\s*\+$/.test(raw)) parts.push('+');
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
    if (mapped === '#') {
      // SendKeys has no Windows-key modifier: '#' was typed as a literal "#",
      // so "win+r" typed "#r" into whatever had focus. Those chords go through
      // `winChordVirtualKeys` (real key events) instead.
      throw new Error(
        `the Windows key cannot be sent through SendKeys (chord ${JSON.stringify(chord)}); use winChordVirtualKeys`,
      );
    }
    if (!modifierChars.includes(mapped)) modifierChars.push(mapped);
  }

  const named = NAMED_KEYS[last.toLowerCase()];
  // SendKeys types an uppercase letter WITH Shift, so «ctrl+A» became Ctrl+Shift+A
  // (and «ctrl+C» Ctrl+Shift+C: devtools in Chrome instead of copy). In a chord the
  // letter names a key, not a character: Shift is only pressed when asked for.
  const key = modifiers.length > 0 && /^[A-Z]$/.test(last) ? last.toLowerCase() : last;
  const target = named ?? (key.length === 1 ? braceKey(key) : undefined);

  if (!target) {
    // The bug this replaces: returning the raw string made SendKeys type it.
    throw new Error(
      `unrecognised key ${JSON.stringify(last)} in chord ${JSON.stringify(chord)}. ` +
        `Use a named key (enter, tab, escape, f1-f16, arrows) or a single character.`,
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
/** ASCII that SendKeys cannot type literally; see `splitAsciiSegments`. */
const PASTE_ONLY_ASCII = new Set(['{', '}']);

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
    // Braces go through the paste path too: SendKeys reads `{...}` as a key name,
    // so typed text like `{"a":1}` failed with an invalid-key error and text such
    // as `{ENTER}` or `{DEL 50}` (from a page, a mail, a file) was PRESSED instead
    // of typed. Pasted, they arrive as the literal characters.
    const kind =
      (ch.codePointAt(0) as number) < 128 && !PASTE_ONLY_ASCII.has(ch) ? 'ascii' : 'unicode';
    if (kind !== currentKind) {
      push();
      currentKind = kind;
    }
    current += ch;
  }
  push();
  return out;
}

const VK_MODIFIERS: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  altgr: 0x12,
  win: 0x5b,
  windows: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
};

const VK_NAMED: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  bksp: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  ins: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  pgup: 0x21,
  pgdn: 0x22,
  arrowup: 0x26,
  arrowdown: 0x28,
  arrowleft: 0x25,
  arrowright: 0x27,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  space: 0x20,
  spacebar: 0x20,
  printscreen: 0x2c,
  prtsc: 0x2c,
  prtscn: 0x2c,
  // VK_OEM_PLUS / VK_OEM_MINUS: the «=+» and «-_» keys (win++ / win+- zoom the
  // magnifier in and out).
  '+': 0xbb,
  plus: 0xbb,
  '=': 0xbb,
  '-': 0xbd,
  minus: 0xbd,
  '.': 0xbe,
  ',': 0xbc,
  ';': 0xba,
};

/**
 * F17–F24, alone or with Ctrl/Shift/Alt, as real key events. SendKeys stops at
 * F16, so these chords were refused. Every other chord returns null and keeps
 * going through SendKeys exactly as before; Windows-key chords are
 * `winChordVirtualKeys`' job and are checked first by the caller.
 */
export function highFunctionKeyVirtualKeys(chord: string): number[] | null {
  const parts = chord
    .trim()
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const last = parts[parts.length - 1];
  const f = last === undefined ? null : /^f(1[7-9]|2[0-4])$/.exec(last);
  if (!f) return null;
  const codes: number[] = [];
  for (const m of parts.slice(0, -1)) {
    const vk = VK_MODIFIERS[m];
    if (vk === undefined) {
      throw new Error(`unknown modifier ${JSON.stringify(m)} in chord ${JSON.stringify(chord)}`);
    }
    if (!codes.includes(vk)) codes.push(vk);
  }
  codes.push(0x70 + Number(f[1]) - 1);
  return codes;
}

/**
 * Virtual-key codes for a chord that uses the Windows key, in press order
 * (modifiers first, then the key), or null when the chord has no Windows key.
 *
 * SendKeys cannot hold the Windows key, so these chords (win+d, win+r, win+e,
 * win+shift+s…) are sent as real key-down/key-up events. Only keys with a fixed
 * virtual-key code are accepted: letters, digits, f1-f24, the named keys above and
 * the Windows key alone; anything else is refused instead of guessed.
 */
export function winChordVirtualKeys(chord: string): number[] | null {
  const raw = chord.trim();
  const parts = raw
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  // «win++» splits into ['win'] once the empty pieces are dropped, which pressed
  // the Windows key alone (Start menu) instead of Win+Plus. Same rule as
  // parseKeyChord: a chord ending in two '+' means the '+' key itself.
  if (parts.length > 0 && /\+\s*\+$/.test(raw)) parts.push('+');
  if (parts.length === 0) return null;
  const isWin = (p: string) => VK_MODIFIERS[p] === 0x5b;
  if (!parts.some(isWin)) return null;
  // "win" on its own opens Start: the Windows key is the whole chord.
  if (parts.length === 1) return [0x5b];
  const last = parts[parts.length - 1] as string;
  const codes: number[] = [];
  for (const m of parts.slice(0, -1)) {
    const vk = VK_MODIFIERS[m];
    if (vk === undefined) {
      throw new Error(`unknown modifier ${JSON.stringify(m)} in chord ${JSON.stringify(chord)}`);
    }
    if (!codes.includes(vk)) codes.push(vk);
  }
  let target: number | undefined;
  if (VK_MODIFIERS[last] !== undefined) target = VK_MODIFIERS[last];
  else if (VK_NAMED[last] !== undefined) target = VK_NAMED[last];
  else if (/^[a-z0-9]$/.test(last)) target = last.toUpperCase().charCodeAt(0);
  else {
    const f = /^f([1-9]|1\d|2[0-4])$/.exec(last);
    if (f) target = 0x70 + Number(f[1]) - 1;
  }
  if (target === undefined) {
    throw new Error(
      `unrecognised key ${JSON.stringify(last)} in Windows-key chord ${JSON.stringify(chord)}. ` +
        'Use a letter, a digit, f1-f24 or a named key (enter, tab, arrows…).',
    );
  }
  if (!codes.includes(target)) codes.push(target);
  return codes;
}
