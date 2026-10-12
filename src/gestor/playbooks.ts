/**
 * Per-domain playbooks (capability 3, PR3 / D4): durable EXECUTABLE knowledge
 * about a site - the login flow that worked, selectors that worked, quirks
 * and waits - so the next gestión on the same domain does not start from
 * zero. Knowledge only: what a careful human would jot down after figuring a
 * portal out.
 *
 * One Markdown file per canonical domain, <state>/playbooks/<domain>.md, the
 * same pattern as the skills store: Nico can read and fix a file by hand at
 * 2am, and every write round-trips through the format instead of a private
 * in-memory shape. A save rebuilds the file from the structured fields, so
 * content outside the three sections does not survive a save (declared, not
 * hidden).
 *
 * Credentials NEVER live here - only vault key NAMES as references
 * (`site:<dominio>:password` points at the secret without containing it). The
 * guard is positive and provable, and lives in the gestion tool before any
 * save: the whole rendered content is checked against ALL current vault
 * values (exact, case-sensitive substring match); one match rejects the save
 * and nothing is written. Declared limit: a PARTIAL fragment of a secret, or
 * a secret that is not in the vault, cannot be detected that way - that is
 * why the content is structured into sections and references go by key name.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDomain } from './login.js';

export interface Playbook {
  /** Canonical domain (normalizeDomain); doubles as the file name. */
  domain: string;
  updatedAt: string;
  /** Login flow lines that worked. Vault key NAMES only, never a value. */
  login: string[];
  /** Selectors that worked, one line each: what it is + the selector. */
  selectores: string[];
  /** Quirks and waits: iframes, captchas, multi-step flows, timeouts. */
  quirks: string[];
}

/** A line is one line; a section stays glanced-at-able, not a novel. */
export const MAX_PLAYBOOK_LINE_CHARS = 200;
export const MAX_PLAYBOOK_LINES_PER_SECTION = 20;

/**
 * The canonical playbook domain for an input, or null when the input cannot
 * name a host. Same convention as the vault login keys (normalizeDomain), so
 * `www.x.es`, `https://x.es/path` and `x.es:8443` all land on the same file
 * and a playbook can never be orphaned from the domain `preparar` looks up.
 * The canonical charset ([a-z0-9.-], no `..`, no separators) also makes the
 * file name safe by construction: no path traversal is representable.
 */
export function canonicalPlaybookDomain(input: string): string | null {
  return normalizeDomain(input);
}

/** What one playbook writes to disk, in full. */
export function renderPlaybook(pb: Playbook): string {
  const section = (title: string, lines: string[]): string[] => [
    `## ${title}`,
    '',
    ...(lines.length > 0 ? lines.map((l) => `- ${l}`) : ['(sin notas)']),
    '',
  ];
  return [
    '---',
    `domain: ${pb.domain}`,
    `updated: ${pb.updatedAt}`,
    '---',
    '',
    `# Playbook: ${pb.domain}`,
    '',
    ...section('Login', pb.login),
    ...section('Selectores', pb.selectores),
    ...section('Quirks', pb.quirks),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n');
}

/** Reads the three sections back out of the Markdown; tolerant of hand edits. */
type SectionName = 'login' | 'selectores' | 'quirks';

export function parsePlaybook(domain: string, text: string): Playbook {
  const sections: Record<SectionName, string[]> = { login: [], selectores: [], quirks: [] };
  const byHeader: Record<string, SectionName> = {
    login: 'login',
    selectores: 'selectores',
    quirks: 'quirks',
  };
  let updatedAt = '';
  let current: SectionName | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('updated:')) {
      updatedAt = line.slice('updated:'.length).trim();
      continue;
    }
    const header = /^##\s+(.+)$/.exec(line);
    if (header) {
      current = byHeader[(header[1] ?? '').trim().toLowerCase()] ?? null;
      continue;
    }
    if (!current || !line.startsWith('- ')) continue;
    const note = line.slice(2).trim();
    if (note && note !== '(sin notas)') sections[current].push(note);
  }
  return {
    domain,
    updatedAt,
    login: sections.login,
    selectores: sections.selectores,
    quirks: sections.quirks,
  };
}

/** Caps, in one place: a playbook that does not fit is rejected, never trimmed. */
export function validatePlaybook(pb: Playbook): string | null {
  const groups: Array<[string, string[]]> = [
    ['login', pb.login],
    ['selectores', pb.selectores],
    ['quirks', pb.quirks],
  ];
  for (const [name, lines] of groups) {
    if (lines.length > MAX_PLAYBOOK_LINES_PER_SECTION) {
      return `La sección ${name} no puede tener más de ${MAX_PLAYBOOK_LINES_PER_SECTION} notas (tiene ${lines.length}): quédate con lo que de verdad reutilizarías.`;
    }
    const tooLong = lines.findIndex((l) => l.length > MAX_PLAYBOOK_LINE_CHARS);
    if (tooLong !== -1) {
      return `La nota ${tooLong + 1} de ${name} no puede pasar de ${MAX_PLAYBOOK_LINE_CHARS} caracteres (tiene ${lines[tooLong]?.length ?? 0}): resúmela.`;
    }
    if (lines.some((l) => l.includes('\n'))) {
      return `Cada nota de ${name} es una sola línea: divide las que tengan saltos.`;
    }
  }
  return null;
}

/**
 * Whether `content` contains any of the given vault values, exactly as stored
 * (case-sensitive substring). Empty values cannot match: `includes('')` is
 * always true, so they are skipped and the guarantee stays meaningful.
 */
export function containsVaultValue(content: string, values: readonly string[]): boolean {
  return values.some((v) => v.length > 0 && content.includes(v));
}

/** The store: one Markdown file per canonical domain under `dir`. */
export class PlaybookStore {
  readonly dir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  #path(domain: string): string {
    return join(this.dir, `${domain}.md`);
  }

  /** The playbook for a canonical domain, or null when there is none. */
  read(domain: string): Playbook | null {
    const canonical = canonicalPlaybookDomain(domain);
    if (!canonical) return null;
    const path = this.#path(canonical);
    if (!existsSync(path)) return null;
    try {
      return parsePlaybook(canonical, readFileSync(path, 'utf8'));
    } catch {
      return null; // a corrupt file reads as "no playbook", never as a crash
    }
  }

  /** Rebuilds the file from the structured fields (see the module doc). */
  save(pb: Playbook): void {
    const tmp = join(this.dir, `.${pb.domain}.md.tmp`);
    writeFileSync(tmp, renderPlaybook(pb), 'utf8');
    renameSync(tmp, this.#path(pb.domain));
  }
}
