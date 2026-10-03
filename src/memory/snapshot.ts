/**
 * MEMORIA.md and PERFIL.md: two tiny, human-editable snapshots that travel with
 * the user instead of with a chat.
 *
 * The per-scope MemoryStore answers "what do I know about this conversation";
 * it cannot answer "what must every conversation know", because nothing pulls
 * it into a turn that did not ask. These two files are the opposite bet: small
 * enough to be assembled into one context note on every turn, plain enough that
 * the user opens them in Notepad and fixes a typo without corrupting anything.
 *
 * The format is prose entries separated by `\n§\n`, most recent last. Not JSON,
 * not a database: `§` is rare enough that natural prose never contains it and
 * visible enough that a human can cut on it by hand.
 *
 * The caps (2200 chars for MEMORIA, 1375 for PERFIL) are budgets, not
 * suggestions — both files land in the system prompt, and a memory that does
 * not fit in the prompt is not memory. Every method is wrapped so that a locked
 * or missing file degrades to "remembered nothing" instead of killing a turn:
 * a lost nudge costs a question, a thrown error costs the whole reply.
 *
 * Two rules guard what gets written, because these files are pasted into the
 * system prompt on every single turn:
 *
 * - Credentials never enter them. A password pasted "for safekeeping" would be
 *   read back by the model on every following turn, in every chat. Entries that
 *   look like a secret are refused with a reason, not redacted: this is the
 *   user's own profile, and silently rewriting what they said is lying to them.
 *   The reason goes back so the user decides what to do with the value.
 *
 * - A save reports what actually happened. writeFileSync can fail (locked file,
 *   full disk, read-only directory) and the tool must be able to tell the user
 *   "not saved" instead of "saved": a success message over a failed write is
 *   worse than no memory at all. So the writers return a SaveResult and only
 *   `ok: true` once the bytes are verified on disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

export type SnapshotFile = 'memoria' | 'perfil';

export interface SnapshotTexts {
  memoria: string;
  perfil: string;
}

export interface MemorySnapshotOptions {
  dir: string;
  /**
   * One knob for both files: a caller that wants a tighter budget wants it
   * everywhere. Absent means each file keeps its own default.
   */
  maxChars?: number;
}

/** Entries sit between these markers, most recent at the end. */
export const ENTRY_SEPARATOR = '\n§\n';

export const DEFAULT_MEMORIA_CHARS = 2200;
export const DEFAULT_PERFIL_CHARS = 1375;

/**
 * What a write actually did. `ok` is true only once the bytes are on disk; a
 * false result carries the refusal reason (the entry looked like a secret) or
 * the disk error. Callers must never report "saved" on a false result — that is
 * how someone stops worrying about a password that was never stored.
 */
export interface SaveResult {
  ok: boolean;
  /** Disk-level failure message, kept free of the entry that was being written. */
  error?: string;
  /** Why the entry was refused, phrased for the user. */
  reason?: string;
}

/** Reason used when prose names a credential keyword with a value after it. */
const SECRET_PROSE_REASON = 'una contraseña, token o clave en texto plano';

const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * 13 to 19 digits, optionally grouped with single spaces or dashes. No Luhn
 * check on purpose: a missed card number leaks to the model every turn while a
 * refused order number only costs a rephrase, and the user sees the reason.
 */
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/;

/** Known token shapes. The prefix is the signal, so the tail minimums stay low. */
const TOKEN_SHAPES: ReadonlyArray<{ re: RegExp; why: string }> = [
  // Lookbehind instead of \b: a hyphen before the prefix ("my-task-…") counts
  // as a word boundary, and "sk-" must not fire on ordinary hyphenated words.
  { re: /(?<![A-Za-z0-9_-])(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}/i, why: 'un token de API' },
  { re: /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{6,}/, why: 'un token de GitHub' },
  { re: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{6,}/, why: 'un token de GitHub' },
  { re: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{6,}/, why: 'un token de Slack' },
  { re: /(?<![A-Za-z0-9_-])AKIA[A-Z0-9]{12,}/, why: 'una clave de AWS' },
  { re: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{12,}/, why: 'una clave de Google' },
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}/, why: 'un JWT' },
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, why: 'un token de bot de Telegram' },
];

/**
 * A credential keyword counts only with a value after it ("password: x", "mi
 * contraseña de la banca es 1234"). A bare mention ("no me preguntes por
 * contraseñas") is ordinary prose and must survive the filter, so the shape is
 * keyword + separator + value, never the keyword alone. `[:=]` accepts any
 * value; the Spanish copula "es" counts as separator only when the value
 * carries a digit, because "mi clave es simple" is an opinion while
 * "mi clave es 1234" is a secret.
 */
const SECRET_KEYWORD_SRC =
  '(?:passwords?|passwds?|claves?|contrase[nñ]as?|pwd|tokens?|secrets?|api[_\\s-]?keys?)';
const ASSIGNED_VALUE_SRC = `\\b${SECRET_KEYWORD_SRC}\\b[^.!?\\n]{0,48}?[:=]\\s*(\\S{1,120})`;
const COPULA_VALUE_SRC = `\\b${SECRET_KEYWORD_SRC}\\b[^.!?\\n]{0,48}?\\bes\\b\\s*(\\S{1,120})`;

/**
 * The Spanish reason to refuse `text`, or null when it looks clean. Refusal is
 * better than storage here: what is written into MEMORIA.md/PERFIL.md is read
 * by the model on every later turn, so a secret that slips through is exposed
 * forever. Redacting in silence was rejected on purpose — the profile is the
 * user's own words and rewriting them behind their back is lying to them.
 */
export function looksLikeSecret(text: string): string | null {
  if (PRIVATE_KEY_RE.test(text)) return 'una clave privada';
  for (const shape of TOKEN_SHAPES) {
    if (shape.re.test(text)) return shape.why;
  }
  if (CARD_RE.test(text)) return 'un número de tarjeta';
  for (const match of text.matchAll(new RegExp(ASSIGNED_VALUE_SRC, 'gi'))) {
    if (match[1]) return SECRET_PROSE_REASON;
  }
  for (const match of text.matchAll(new RegExp(COPULA_VALUE_SRC, 'gi'))) {
    const value = match[1];
    if (value && /\d/.test(value)) return SECRET_PROSE_REASON;
  }
  return null;
}

/**
 * Error text safe to show the user: fs errors carry paths and codes, never the
 * buffer that was being written, but anything credential-shaped is dropped
 * instead of echoed back inside an error message.
 */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return looksLikeSecret(message) ? 'el disco rechazó la escritura' : message;
}

interface FileSpec {
  name: string;
  /** Written on first touch, so the user finds a documented format, not a void. */
  template: string;
  defaultChars: number;
}

const SPECS: Record<SnapshotFile, FileSpec> = {
  memoria: {
    name: 'MEMORIA.md',
    template: '# MEMORIA\n\n',
    defaultChars: DEFAULT_MEMORIA_CHARS,
  },
  perfil: {
    name: 'PERFIL.md',
    template: '# PERFIL\n\n',
    defaultChars: DEFAULT_PERFIL_CHARS,
  },
};

export class MemorySnapshot {
  readonly dir: string;
  readonly maxChars: Record<SnapshotFile, number>;

  constructor(opts: MemorySnapshotOptions) {
    this.dir = opts.dir;
    this.maxChars = {
      memoria: opts.maxChars ?? SPECS.memoria.defaultChars,
      perfil: opts.maxChars ?? SPECS.perfil.defaultChars,
    };
  }

  /** Contents without the title scaffold. Missing files are created empty. */
  load(): SnapshotTexts {
    return { memoria: this.#body('memoria'), perfil: this.#body('perfil') };
  }

  saveMemoria(text: string): SaveResult {
    return this.#save('memoria', text);
  }

  savePerfil(text: string): SaveResult {
    return this.#save('perfil', text);
  }

  /**
   * Append one entry at the end, evicting from the front once the cap bites.
   * A refused entry is not written at all: storing a redacted copy would
   * rewrite the user's words, and a truncated secret still leaks its prefix.
   */
  appendEntry(file: SnapshotFile, entry: string): SaveResult {
    const reason = looksLikeSecret(entry);
    if (reason) {
      log.warn('memory snapshot refused a secret-looking entry', { file, reason });
      return { ok: false, reason };
    }
    try {
      const cap = this.maxChars[file];
      // The separator inside an entry would split it in two on the next read.
      let clean = entry.replace(/\n§\n/g, ' ').trim();
      if (clean.length > cap) {
        clean = clean.slice(0, cap).trimEnd();
        log.warn('memory snapshot entry truncated to fit the cap', { file, cap });
      }
      const entries = this.#entries(file);
      entries.push(clean);
      let evicted = 0;
      while (entries.join(ENTRY_SEPARATOR).length > cap && entries.length > 1) {
        entries.shift();
        evicted++;
      }
      if (evicted > 0) {
        log.warn('memory snapshot hit its cap, evicted oldest entries', { file, evicted, cap });
      }
      this.#write(file, entries.join(ENTRY_SEPARATOR));
      return { ok: true };
    } catch (err) {
      const error = safeError(err);
      log.warn('memory snapshot append failed', { file, err: error });
      return { ok: false, error };
    }
  }

  /** The two blocks for the system prompt. Empty blocks would be dead tokens. */
  contextNote(): string {
    try {
      const { memoria, perfil } = this.load();
      const blocks: string[] = [];
      const memory = memoria.trim();
      const profile = perfil.trim();
      if (memory) blocks.push(`<memory>\n${memory}\n</memory>`);
      if (profile) blocks.push(`<profile>\n${profile}\n</profile>`);
      return blocks.join('\n');
    } catch (err) {
      log.warn('memory snapshot context note failed', { err: String(err) });
      return '';
    }
  }

  #path(file: SnapshotFile): string {
    return join(this.dir, SPECS[file].name);
  }

  /**
   * The template is scaffolding for whoever opens the file, not content: it is
   * stripped so a fresh file reads as empty and the second read matches the
   * first instead of surprising the caller with a title line.
   */
  #body(file: SnapshotFile): string {
    try {
      const spec = SPECS[file];
      const path = this.#path(file);
      if (!existsSync(path)) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(path, spec.template, 'utf8');
        return '';
      }
      const text = readFileSync(path, 'utf8');
      return text.startsWith(spec.template) ? text.slice(spec.template.length) : text;
    } catch (err) {
      log.warn('memory snapshot read failed', { file, err: String(err) });
      return '';
    }
  }

  #entries(file: SnapshotFile): string[] {
    return this.#body(file)
      .split(ENTRY_SEPARATOR)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  /** Wholesale replace. Same contract as appendEntry: refuse, or really write. */
  #save(file: SnapshotFile, text: string): SaveResult {
    const reason = looksLikeSecret(text);
    if (reason) {
      log.warn('memory snapshot refused a secret-looking save', { file, reason });
      return { ok: false, reason };
    }
    try {
      this.#write(file, this.#capped(text, this.maxChars[file]));
      return { ok: true };
    } catch (err) {
      const error = safeError(err);
      log.warn('memory snapshot save failed', { file, err: error });
      return { ok: false, error };
    }
  }

  /**
   * A wholesale save is written oldest first, so the head is what the writer
   * put first and the cut keeps it, dropping the tail at the last entry
   * boundary inside the budget. With no boundary in sight there is nothing
   * better than a hard truncate.
   */
  #capped(text: string, cap: number): string {
    if (text.length <= cap) return text;
    const window = text.slice(0, cap);
    const at = window.lastIndexOf(ENTRY_SEPARATOR);
    return at > 0 ? text.slice(0, at) : window;
  }

  /**
   * The write is verified by reading it back: a truncated write (full disk,
   * quota) must not be reported as success, so `ok: true` can only mean the
   * bytes are really on disk.
   */
  #write(file: SnapshotFile, body: string): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.#path(file);
    const content = SPECS[file].template + body;
    writeFileSync(path, content, 'utf8');
    if (readFileSync(path, 'utf8') !== content) {
      throw new Error('memory snapshot write verification did not match');
    }
  }
}
