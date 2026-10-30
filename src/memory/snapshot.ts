/**
 * PERFIL.md: a tiny, human-editable snapshot that travels with the user
 * instead of with a chat.
 *
 * The per-scope MemoryStore answers "what do I know about this conversation";
 * it cannot answer "what must every conversation know", because nothing pulls
 * it into a turn that did not ask. This file is the opposite bet: small
 * enough to be assembled into one context note on every turn, plain enough
 * that the user opens it in Notepad and fixes a typo without corrupting
 * anything.
 *
 * There used to be a second snapshot, MEMORIA.md, feeding a frozen <memory>
 * block next to <profile>. Nothing in runtime ever wrote to it — the only
 * writer lived in tests — so the writer is gone: the file is never created
 * and never saved. But the file was human-editable, so a preexisting
 * non-empty MEMORIA.md is still READ and emitted as <memoria_legada>
 * (read-compat) - a distinct tag on purpose: the live per-chat memory index in
 * the prompt uses <memory> (cli.ts renderMemoryContext) and the two blocks
 * carry different semantics, so the model must be able to tell them apart.
 * until its entries are migrated into the per-chat MemoryStore and the file
 * is removed by hand. Dropping those bytes silently would be lying by
 * omission about what the assistant remembers.
 *
 * The format is prose entries separated by `\n§\n`, most recent last. Not JSON,
 * not a database: `§` is rare enough that natural prose never contains it and
 * visible enough that a human can cut on it by hand.
 *
 * The cap (1375 chars) is a budget, not a suggestion — the file lands in the
 * system prompt, and a profile that does not fit in the prompt is not a
 * profile. Every method is wrapped so that a locked or missing file degrades
 * to "remembered nothing" instead of killing a turn: a lost nudge costs a
 * question, a thrown error costs the whole reply.
 *
 * Two rules guard what gets written, because this file is pasted into the
 * system prompt on every single turn:
 *
 * - Credentials never enter it. A password pasted "for safekeeping" would be
 *   read back by the model on every following turn, in every chat. Entries
 *   that look like a secret are refused with a reason, not redacted: this is
 *   the user's own profile, and silently rewriting what they said is lying to
 *   them. The reason goes back so the user decides what to do with the value.
 *
 * - A save reports what actually happened. writeFileSync can fail (locked
 *   file, full disk, read-only directory) and the tool must be able to tell
 *   the user "not saved" instead of "saved": a success message over a failed
 *   write is worse than no memory at all. So the writers return a SaveResult
 *   and only `ok: true` once the bytes are verified on disk.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

export interface MemorySnapshotOptions {
  dir: string;
  /** A tighter budget for the whole file. Absent keeps the default. */
  maxChars?: number;
}

/** Entries sit between these markers, most recent at the end. */
export const ENTRY_SEPARATOR = '\n§\n';

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
 * better than storage here: what is written into PERFIL.md is read
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

const SPEC = {
  name: 'PERFIL.md',
  /** Written on first touch, so the user finds a documented format, not a void. */
  template: '# PERFIL\n\n',
  defaultChars: DEFAULT_PERFIL_CHARS,
};

export class MemorySnapshot {
  readonly dir: string;
  readonly maxChars: number;

  constructor(opts: MemorySnapshotOptions) {
    this.dir = opts.dir;
    this.maxChars = opts.maxChars ?? SPEC.defaultChars;
  }

  /** Contents without the title scaffold. A missing file is created empty. */
  load(): string {
    return this.#body();
  }

  savePerfil(text: string): SaveResult {
    return this.#save(text);
  }

  /**
   * Append one entry at the end, evicting from the front once the cap bites.
   * A refused entry is not written at all: storing a redacted copy would
   * rewrite the user's words, and a truncated secret still leaks its prefix.
   */
  appendEntry(entry: string): SaveResult {
    const reason = looksLikeSecret(entry);
    if (reason) {
      log.warn('memory snapshot refused a secret-looking entry', { reason });
      return { ok: false, reason };
    }
    try {
      const cap = this.maxChars;
      // The separator inside an entry would split it in two on the next read.
      let clean = entry.replace(/\n§\n/g, ' ').trim();
      if (clean.length > cap) {
        clean = clean.slice(0, cap).trimEnd();
        log.warn('memory snapshot entry truncated to fit the cap', { cap });
      }
      const entries = this.#entries();
      entries.push(clean);
      let evicted = 0;
      while (entries.join(ENTRY_SEPARATOR).length > cap && entries.length > 1) {
        entries.shift();
        evicted++;
      }
      if (evicted > 0) {
        log.warn('memory snapshot hit its cap, evicted oldest entries', { evicted, cap });
      }
      this.#write(entries.join(ENTRY_SEPARATOR));
      return { ok: true };
    } catch (err) {
      const error = safeError(err);
      log.warn('memory snapshot append failed', { err: error });
      return { ok: false, error };
    }
  }

  /**
   * Borrable por diseño: quita las entradas que contienen el texto dado, sin
   * distinguir mayúsculas ni acentos. Una query vacía no borra nada. Devuelve
   * cuántas entradas salieron; el llamador debe decir la verdad del resultado.
   */
  removeEntries(query: string): number {
    const fold = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const needle = fold(query).trim();
    if (!needle) return 0;
    try {
      const entries = this.#entries();
      const kept = entries.filter((e) => !fold(e).includes(needle));
      const removed = entries.length - kept.length;
      if (removed === 0) return 0;
      this.#write(kept.join(ENTRY_SEPARATOR));
      log.info('memory snapshot entries removed', { removed });
      return removed;
    } catch (err) {
      log.warn('memory snapshot remove failed', { err: String(err) });
      return 0;
    }
  }

  /**
   * The blocks for the system prompt. Empty blocks would be dead tokens. A
   * legacy MEMORIA.md found on disk is still honored (read-only, never
   * created): its entries may be manual, and ignoring them would silently
   * forget something the user wrote.
   */
  contextNote(): string {
    try {
      const blocks: string[] = [];
      const legacy = this.#legacyMemoria();
      if (legacy) blocks.push(`<memoria_legada>\n${legacy}\n</memoria_legada>`);
      const profile = this.load().trim();
      if (profile) blocks.push(`<profile>\n${profile}\n</profile>`);
      return blocks.join('\n');
    } catch (err) {
      log.warn('memory snapshot context note failed', { err: String(err) });
      return '';
    }
  }

  #path(): string {
    return join(this.dir, SPEC.name);
  }

  /**
   * Legacy MEMORIA.md, strictly read-only: an existing file is honored, a
   * missing one is NOT created (unlike PERFIL.md) and nothing ever writes to
   * it. A present file logs a migration nudge once per read; the day the user
   * moves its entries into chat memory and deletes the file, this reader
   * becomes a no-op and can go away.
   */
  #legacyMemoria(): string {
    try {
      const path = join(this.dir, 'MEMORIA.md');
      if (!existsSync(path)) return '';
      const text = readFileSync(path, 'utf8');
      const body = text.startsWith('# MEMORIA\n\n') ? text.slice('# MEMORIA\n\n'.length) : text;
      const trimmed = body.trim();
      if (trimmed) {
        log.warn(
          'legacy MEMORIA.md is still in use; move its entries into chat memory and delete the file',
        );
      }
      return trimmed;
    } catch (err) {
      log.warn('legacy MEMORIA.md read failed', { err: String(err) });
      return '';
    }
  }

  /**
   * The template is scaffolding for whoever opens the file, not content: it is
   * stripped so a fresh file reads as empty and the second read matches the
   * first instead of surprising the caller with a title line.
   */
  #body(): string {
    try {
      const path = this.#path();
      if (!existsSync(path)) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(path, SPEC.template, 'utf8');
        return '';
      }
      const text = readFileSync(path, 'utf8');
      return text.startsWith(SPEC.template) ? text.slice(SPEC.template.length) : text;
    } catch (err) {
      log.warn('memory snapshot read failed', { err: String(err) });
      return '';
    }
  }

  #entries(): string[] {
    return this.#body()
      .split(ENTRY_SEPARATOR)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  /** Wholesale replace. Same contract as appendEntry: refuse, or really write. */
  #save(text: string): SaveResult {
    const reason = looksLikeSecret(text);
    if (reason) {
      log.warn('memory snapshot refused a secret-looking save', { reason });
      return { ok: false, reason };
    }
    try {
      this.#write(this.#capped(text, this.maxChars));
      return { ok: true };
    } catch (err) {
      const error = safeError(err);
      log.warn('memory snapshot save failed', { err: error });
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
  #write(body: string): void {
    mkdirSync(this.dir, { recursive: true });
    const path = this.#path();
    const content = SPEC.template + body;
    // tmp + verificación + rename: una escritura truncada (disco lleno, cuota) o un
    // corte a medias deja el PERFIL.md anterior intacto. Antes se escribía encima y
    // el error llegaba con el perfil ya destrozado.
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, content, 'utf8');
      if (readFileSync(tmp, 'utf8') !== content) {
        throw new Error('memory snapshot write verification did not match');
      }
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}
