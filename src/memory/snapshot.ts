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

  saveMemoria(text: string): void {
    this.#save('memoria', text);
  }

  savePerfil(text: string): void {
    this.#save('perfil', text);
  }

  /** Append one entry at the end, evicting from the front once the cap bites. */
  appendEntry(file: SnapshotFile, entry: string): void {
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
    } catch (err) {
      log.warn('memory snapshot append failed', { file, err: String(err) });
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

  #save(file: SnapshotFile, text: string): void {
    try {
      this.#write(file, this.#capped(text, this.maxChars[file]));
    } catch (err) {
      log.warn('memory snapshot save failed', { file, err: String(err) });
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

  #write(file: SnapshotFile, body: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.#path(file), SPECS[file].template + body, 'utf8');
  }
}
