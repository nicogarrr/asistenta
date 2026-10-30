import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { paths } from './paths.js';

/**
 * Long-term memory: one markdown file per scope, human-editable, capped.
 *
 * The design constraint is not "remember more", it is "still be able to read
 * everything". A prompt that grows by 200 tokens a week eventually stops
 * fitting, and the first thing that gets cut is the oldest thing, which is
 * usually the most useful. So memory is one file per chat, a hard byte cap,
 * and a file format that is a bullet list rather than a database: the model
 * edits it with a text tool when it wants to, and the parse tolerates whatever
 * it wrote there.
 *
 * ```
 * # Memory for telegram:main:8258546109
 *
 * - [m3f2a1b4] (2026-10-01) user prefers answers in Spanish
 * - [a71c0de5] (2026-10-02, tags: lang work, supersedes: m3f2a1b4) user prefers Catalan
 * - [m3f2a1b4] (2026-10-01, superseded-by: a71c0de5) user prefers answers in Spanish
 * ```
 *
 * Metadata after the date is optional `key: value` pairs, comma separated, so
 * the agent can add a fact or correct one with a plain text write.
 */
export interface MemoryEntry {
  id: string;
  /** `YYYY-MM-DD`, the day the fact was written down. */
  date: string;
  text: string;
  tags: string[];
  /** Ids of the entries this one replaces. */
  supersedes: string[];
  /** Set on the entry that was replaced, so history stays auditable. */
  supersededBy: string | null;
}

export interface MemoryDoc {
  scope: string;
  entries: MemoryEntry[];
  /**
   * Anything the model or the user wrote that is not a bullet. Preserved
   * verbatim: silently dropping a hand-written section the next time a fact is
   * added is how an agent loses the user's trust in its own memory.
   */
  notes: string[];
}

export interface RememberOptions {
  tags?: string[];
  /** Replace the entry with this id in place instead of appending a new one. */
  id?: string;
  /** Ids this fact replaces. They are marked superseded, not deleted. */
  supersedes?: string[];
}

/**
 * Hard cap on one scope's file. Past this the oldest entries are evicted: an
 * unbounded memory file eventually does not fit in a prompt, and the failure
 * mode is silent truncation of the system prompt in the middle of a run.
 */
export const MAX_MEMORY_BYTES = 64 * 1024;
const MAX_ENTRY_CHARS = 2_000;
const DEFAULT_RECALL = 10;
const MAX_RECALL = 50;
/** Windows allows 255 chars per component; the stem is kept well under it. */
const MAX_SCOPE_STEM = 96;
const SUFFIX = '.md';

/**
 * Credential-shaped text is refused at the content boundary, not only at the
 * path boundary. `CREDENTIAL_PATH` in permissions.ts is deliberately not exported
 * and covers paths; memory holds prose, so a token pasted into a chat would end
 * up in a plaintext file that is loaded into every future prompt. A refusal is
 * cheap here (the user rephrases), the alternative is not.
 */
const SECRET_TOKEN =
  /(?:^|[^A-Za-z0-9])((?:sk|rk|pk)-[A-Za-z0-9_-]{16,}|(?:gh[pousr]_[A-Za-z0-9]{20,})|(?:github_pat_[A-Za-z0-9_]{20,})|(?:xox[baprs]-[A-Za-z0-9-]{10,})|(?:AKIA[0-9A-Z]{16})|(?:AIza[0-9A-Za-z_-]{35})|(?:eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}))/;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const NAMED_SECRET =
  /\b(?:password|passwd|pwd|secret|token|api[\s_-]?key|access[\s_-]?key|bearer|authorization)\b\s*[:=]\s*["']?[^\s"',;]{8,}/i;

/**
 * The same shape said in Spanish ("mi contraseña de Netflix, que es Tigre-9921-xyz").
 * The value must carry a digit or a symbol so "la clave es importante" is prose.
 */
const NAMED_SECRET_ES =
  /\b(?:contraseña|contrasena|clave|pin|passphrase)\b[^.\n]{0,40}?(?:\bes\b|[:=])\s*["']?(?=[^\s"',;]*[\d!@#$%^&*_-])[^\s"',;]{6,}/iu;

/** Luhn, because a bare 13-19 digit run also matches order numbers and epoch stamps. */
function luhn(grouped: string): boolean {
  const digits = grouped.replace(/[ -]/g, '');
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function looksLikeCredential(text: string): boolean {
  if (
    SECRET_TOKEN.test(text) ||
    PRIVATE_KEY_BLOCK.test(text) ||
    NAMED_SECRET.test(text) ||
    NAMED_SECRET_ES.test(text)
  ) {
    return true;
  }
  for (const candidate of text.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    if (luhn(candidate[0])) return true;
  }
  return false;
}

/**
 * Scope to filename. Percent-encoding is reversible and injective; `..`, `:`,
 * `/` and `\` all become `%XX`, so no scope can escape the memory dir and no two
 * scopes can collide (`a_b` and `a:b` stay distinct). Two Windows cases need
 * more: `CON`/`COM1` are device names with *any* extension, and NTFS allows 255
 * characters, so an overlong scope falls back to a digest stem whose scope is
 * recovered from the file header instead of from its name.
 */
const SAFE_CHAR = /^[A-Za-z0-9-]$/;
const RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DIGEST_MARK = '_d';

function percentEncode(scope: string): string {
  let out = '';
  for (const byte of Buffer.from(scope, 'utf8')) {
    const char = String.fromCharCode(byte);
    out +=
      byte < 0x80 && SAFE_CHAR.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function percentDecode(stem: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < stem.length; i++) {
    const char = stem.charAt(i);
    if (char !== '%') {
      if (!SAFE_CHAR.test(char)) return null;
      bytes.push(stem.charCodeAt(i));
      continue;
    }
    const hex = stem.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
    bytes.push(Number.parseInt(hex, 16));
    i += 2;
  }
  return Buffer.from(bytes).toString('utf8');
}

export function scopeToFilename(scope: string): string {
  let stem = percentEncode(scope);
  // `_` is never emitted unencoded (it is not in SAFE_CHAR), so a leading `_`
  // is an unambiguous escape marker rather than something a scope can produce.
  if (RESERVED_STEM.test(stem)) stem = `_${stem}`;
  if (stem.length > MAX_SCOPE_STEM) {
    stem = `${DIGEST_MARK}${createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 32)}`;
  }
  return `${stem}${SUFFIX}`;
}

/**
 * Null for a digest stem: that scope is only recoverable from the file's own
 * header, which is why every file carries one. Callers that need the scope for
 * an arbitrary filename should parse the file (`MemoryStore.scopes`).
 */
export function filenameToScope(filename: string): string | null {
  const stem = filename.endsWith(SUFFIX) ? filename.slice(0, -SUFFIX.length) : filename;
  if (stem.startsWith(DIGEST_MARK)) return null;
  const body = stem.startsWith('_') ? stem.slice(1) : stem;
  return percentDecode(body);
}

export function memoryFile(dir: string, scope: string): string {
  return join(dir, scopeToFilename(scope));
}

const BULLET = /^-\s*\[([A-Za-z0-9_-]{1,32})\]\s*\(([^)]*)\)\s*(.*)$/;
const TITLE = /^#\s*Memory for (.*)$/;

function parseBullet(line: string): MemoryEntry | null {
  const match = BULLET.exec(line);
  if (!match) return null;
  const id = match[1];
  const rawMeta = match[2];
  const rawText = match[3];
  if (!id || rawMeta === undefined || rawText === undefined) return null;
  const fields = rawMeta.split(',').map((f) => f.trim());
  const date = fields.shift() ?? '';
  const entry: MemoryEntry = {
    id,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'unknown',
    text: rawText.trim(),
    tags: [],
    supersedes: [],
    supersededBy: null,
  };
  for (const field of fields) {
    const colon = field.indexOf(':');
    if (colon < 0) continue;
    const key = field.slice(0, colon).trim().toLowerCase();
    const value = field.slice(colon + 1).trim();
    if (!value) continue;
    if (key === 'tags') entry.tags = value.split(/\s+/).filter(Boolean);
    else if (key === 'supersedes') entry.supersedes = value.split(/\s+/).filter(Boolean);
    else if (key === 'superseded-by') entry.supersededBy = value;
    // Unknown metadata is dropped rather than fatal: a hand-written field must
    // not make the whole file unreadable.
  }
  return entry;
}

/**
 * Tolerant on purpose. Every line that is not a title or a bullet becomes a
 * note, so a section the model added by hand survives parse and serialize
 * instead of being deleted by the next `remember`.
 */
export function parseMemory(markdown: string): MemoryDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const doc: MemoryDoc = { scope: '', entries: [], notes: [] };
  for (const [index, line] of lines.entries()) {
    const title = index === 0 ? TITLE.exec(line) : null;
    if (title?.[1] !== undefined) {
      doc.scope = title[1].trim();
      continue;
    }
    if (line.trim() === '') continue;
    const entry = parseBullet(line);
    if (entry) doc.entries.push(entry);
    else doc.notes.push(line.trimEnd());
  }
  return doc;
}

export function serializeMemory(doc: MemoryDoc): string {
  const out = [`# Memory for ${doc.scope}`, ''];
  for (const entry of doc.entries) {
    const meta = [
      entry.date,
      entry.tags.length > 0 ? `tags: ${entry.tags.join(' ')}` : null,
      entry.supersedes.length > 0 ? `supersedes: ${entry.supersedes.join(' ')}` : null,
      entry.supersededBy ? `superseded-by: ${entry.supersededBy}` : null,
    ].filter((part): part is string => part !== null);
    out.push(`- [${entry.id}] (${meta.join(', ')}) ${entry.text}`);
  }
  if (doc.notes.length > 0) out.push('', ...doc.notes);
  return `${out.join('\n')}\n`;
}

export function memoryTitle(scope: string): string {
  return `# Memory for ${scope}`;
}

/** What `read` returns for a scope that has no file yet. */
export function emptyMemoryDoc(scope: string): string {
  return `${memoryTitle(scope)}\n\nNothing remembered yet. One durable fact per bullet, oldest first: \`- [id] (YYYY-MM-DD) fact\`.\n`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tags travel inside the bullet's parenthesis group as a space-separated list.
 * Commas separate the metadata fields and whitespace separates list members:
 * a tag containing either would be silently truncated on the next parse, so
 * both are stripped on the way in.
 */
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw
      .replace(/^#/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .slice(0, 32)
      .toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Lexical scoring, deliberately not a vector search.
 *
 * One human's memory is a few hundred lines. At that size lexical matching is
 * predictable, free, and auditable: you can read why an entry was recalled, and
 * you can find out what the model saw without a second service and an index that
 * has to be rebuilt. Embeddings would add a cost, a failure mode, and a
 * similarity that is hard to argue with when it picks the wrong memory.
 */
export function scoreEntry(entry: MemoryEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  const haystack = `${entry.text} ${entry.tags.join(' ')}`.toLowerCase();
  if (!needle) return 0;
  let score = haystack.includes(needle) ? 4 : 0;
  for (const token of needle.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1)) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

/**
 * One markdown file per scope.
 *
 * Concurrency: every method here runs synchronously from the first read to the
 * last rename, so two facts cannot be written over each other inside one
 * process even though the surrounding turn awaits things between calls. What is
 * NOT protected is a second process — a CLI command and the daemon editing the
 * same scope interleave their read-modify-write and the last rename wins.
 * `assertNotRunning` keeps a second daemon off the state dir; nothing keeps a
 * stray CLI out, so long-lived memory edits belong in the daemon.
 */
export class MemoryStore {
  readonly dir: string;

  constructor(dir: string = paths.memory) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  fileFor(scope: string): string {
    return memoryFile(this.dir, scope);
  }

  read(scope: string): string {
    const file = this.fileFor(scope);
    if (!existsSync(file)) return emptyMemoryDoc(scope);
    return readFileSync(file, 'utf8');
  }

  all(scope: string): MemoryEntry[] {
    return this.#load(scope).entries;
  }

  /**
   * One entry by id, inside the scope's own shelf. The context index and
   * recall/list hand out ids, so the tool needs an exact lookup that never
   * crosses scopes. Returns null when the id is unknown here.
   */
  get(scope: string, id: string): MemoryEntry | null {
    return this.#load(scope).entries.find((e) => e.id === id) ?? null;
  }

  remember(scope: string, text: string, opts: RememberOptions = {}): MemoryEntry {
    const clean = text.trim();
    if (!clean) throw new Error('refusing to store an empty memory');
    if (looksLikeCredential(clean)) {
      throw new Error('refusing to store what looks like a credential; it belongs in the vault');
    }
    // The file is read line by line, so a wrapped fact re-parses as two broken
    // bullets and the second half of a sentence becomes its own "memory".
    if (/[\r\n]/.test(clean)) {
      throw new Error('a memory must be a single line');
    }
    if (clean.length > MAX_ENTRY_CHARS) {
      throw new Error(`memory is ${clean.length} chars, limit is ${MAX_ENTRY_CHARS}`);
    }

    const doc = this.#load(scope);
    const id = opts.id ?? this.#newId(doc);
    const tags = normalizeTags(opts.tags);
    const supersedes = [...(opts.supersedes ?? [])];
    const index = doc.entries.findIndex((e) => e.id === id);
    const previous = index >= 0 ? doc.entries[index] : undefined;
    if (previous) {
      // Explicit id means "correct that line": same slot, same date, new text.
      const corrected: MemoryEntry = { ...previous, text: clean, tags };
      doc.entries[index] = corrected;
      this.#save(scope, doc);
      return corrected;
    }
    const entry: MemoryEntry = {
      id,
      date: today(),
      text: clean,
      tags,
      supersedes,
      supersededBy: null,
    };
    for (const oldId of supersedes) {
      const target = doc.entries.find((e) => e.id === oldId);
      if (!target) {
        log.warn('supersede target not found', { scope, oldId });
        continue;
      }
      target.supersededBy = id;
    }
    doc.entries.push(entry);
    this.#save(scope, doc);
    return entry;
  }

  /** Add a fact that replaces an older one, keeping both visible in the file. */
  supersede(
    scope: string,
    oldId: string,
    text: string,
    opts: { tags?: string[] } = {},
  ): MemoryEntry {
    const doc = this.#load(scope);
    if (!doc.entries.some((e) => e.id === oldId)) {
      throw new Error(`no memory with id ${oldId} in ${scope}`);
    }
    return this.remember(scope, text, { ...opts, supersedes: [oldId] });
  }

  forget(scope: string, id: string): boolean {
    const doc = this.#load(scope);
    const before = doc.entries.length;
    doc.entries = doc.entries.filter((e) => e.id !== id);
    if (doc.entries.length === before) return false;
    this.#save(scope, doc);
    return true;
  }

  /**
   * Delete by text, because that is how a user says it ("forget that I moved to
   * Valencia"). Returns the ids removed so the caller can report exactly what
   * went, since the fuzzy match is the user's problem to see.
   */
  forgetMatching(scope: string, needle: string): string[] {
    const clean = needle.trim().toLowerCase();
    if (!clean) return [];
    const doc = this.#load(scope);
    const removed = doc.entries
      .filter((e) => e.text.toLowerCase().includes(clean))
      .map((e) => e.id);
    if (removed.length === 0) return [];
    const gone = new Set(removed);
    doc.entries = doc.entries.filter((e) => !gone.has(e.id));
    this.#save(scope, doc);
    return removed;
  }

  clear(scope: string): number {
    const doc = this.#load(scope);
    const removed = doc.entries.length;
    doc.entries = [];
    this.#save(scope, doc);
    return removed;
  }

  /** Superseded facts are hidden: a fact that was corrected must not win a recall. */
  recall(scope: string, query: string, limit: number = DEFAULT_RECALL): MemoryEntry[] {
    const cap = Math.max(1, Math.min(MAX_RECALL, Math.floor(limit)));
    const scored = this.#load(scope)
      .entries.filter((e) => e.supersededBy === null)
      .map((entry, index) => ({ entry, index, score: scoreEntry(entry, query) }))
      .filter((hit) => hit.score > 0);
    // Newer first on a tie, so a recent clarification wins over the noise it
    // shares vocabulary with.
    scored.sort((a, b) => b.score - a.score || b.index - a.index);
    return scored.slice(0, cap).map((hit) => hit.entry);
  }

  /** Every scope that has a file, including digest-stemmed ones. */
  scopes(): string[] {
    const out: string[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const doc = parseMemory(readFileSync(join(this.dir, name), 'utf8'));
      if (doc.scope) out.push(doc.scope);
    }
    return out.sort();
  }

  #newId(doc: MemoryDoc): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = `m${randomBytes(4).toString('hex')}`;
      if (!doc.entries.some((e) => e.id === id)) return id;
    }
    throw new Error('could not allocate a memory id');
  }

  /**
   * Read errors are allowed to propagate. Treating "cannot read" as "empty" and
   * then writing would silently replace a memory file the agent merely could not
   * open, and losing memory quietly is worse than failing a turn.
   */
  #load(scope: string): MemoryDoc {
    const file = this.fileFor(scope);
    if (!existsSync(file)) return { scope, entries: [], notes: [] };
    const doc = parseMemory(readFileSync(file, 'utf8'));
    doc.scope = scope;
    return doc;
  }

  #save(scope: string, doc: MemoryDoc): void {
    let evicted = 0;
    let droppedNotes = false;
    let text = serializeMemory(doc);
    const over = (): boolean => Buffer.byteLength(text, 'utf8') > MAX_MEMORY_BYTES;
    // Orden de sacrificio: primero los hechos ya corregidos (superseded: ocultos en
    // recall, solo historia), después las notas a mano y solo al final los hechos
    // vigentes más antiguos. Antes se vaciaban los hechos vigentes hasta dejar uno
    // ANTES de mirar las notas: unas notas grandes se llevaban toda la memoria.
    while (over()) {
      const idx = doc.entries.findIndex((e) => e.supersededBy !== null);
      if (idx < 0 || doc.entries.length <= 1) break;
      doc.entries.splice(idx, 1);
      evicted++;
      text = serializeMemory(doc);
    }
    if (over() && doc.notes.length > 0) {
      // Prose the model wrote by hand is the first thing to go: the entries are
      // the part that has no other copy.
      doc.notes = [];
      droppedNotes = true;
      text = serializeMemory(doc);
    }
    while (over() && doc.entries.length > 1) {
      doc.entries.shift();
      evicted++;
      text = serializeMemory(doc);
    }
    if (evicted > 0) {
      log.warn('memory file hit its cap, evicted oldest entries', {
        scope,
        evicted,
        capBytes: MAX_MEMORY_BYTES,
      });
    }
    if (droppedNotes) {
      log.warn('memory file hit its cap, dropped hand-written notes', {
        scope,
        capBytes: MAX_MEMORY_BYTES,
      });
    }
    const file = this.fileFor(scope);
    // tmp + rename: a crash mid-write must leave the previous memory intact
    // rather than a half-written file the parser would read as "no memories".
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    log.debug('memory written', { scope, entries: doc.entries.length, bytes: text.length });
  }
}
