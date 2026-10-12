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
 * save AND every serve: the rendered content is checked against ALL current
 * vault values (exact, case-sensitive substring match, one snapshot per
 * operation); one match rejects the write or blocks the read, and nothing is
 * written or returned. The guarantee's temporal scope, stated plainly: it
 * covers the snapshot of vault values at THAT operation - a value rotated in
 * afterwards is caught by the revalidation of the NEXT operation, which is
 * why reads revalidate instead of trusting the check made at save time. A
 * hand-edited file gets the same treatment as a stored one.
 *
 * Declared limit: a PARTIAL fragment of a secret, or a secret that is not in
 * the vault, cannot be detected that way - that is why the content is
 * structured into sections and references go by key name.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    if (lines.some((l) => hasForbiddenChar(l))) {
      return `Cada nota de ${name} es una sola línea de texto simple: quita saltos y caracteres de control.`;
    }
  }
  // Structural round-trip: parse(render(pb)) must be exactly pb, or the note
  // smuggled structure past the format (a forged header, a fake bullet).
  const back = parsePlaybook(pb.domain, renderPlaybook(pb));
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (
    !same(back.login, pb.login) ||
    !same(back.selectores, pb.selectores) ||
    !same(back.quirks, pb.quirks)
  ) {
    return 'El contenido no encaja en el formato de playbook (una nota por línea, sin cabeceras ni viñetas propias): reescríbelo como notas simples.';
  }
  return null;
}

/**
 * Characters that can smuggle structure past the one-line-per-note format:
 * CR, Unicode line/paragraph separators, NEL and every C0/C1 control, tab
 * included. A note carrying one reads differently to every other parser, so
 * it is rejected, never cleaned. A code-point loop instead
 * of a regex: the lint rule against control characters in regex literals is
 * right that they are unreadable there.
 */
function hasForbiddenChar(line: string): boolean {
  for (const ch of line) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0d || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
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

  /**
   * Rebuilds the file from the structured fields (see the module doc). The
   * store validates on its own - canonical domain and caps - so no caller can
   * skip the contract. The tmp file is unique per save and created
   * exclusively ('wx'): a pre-planted symlink cannot redirect the write, and
   * a failed save cleans up after itself.
   */
  save(pb: Playbook): void {
    if (canonicalPlaybookDomain(pb.domain) !== pb.domain) {
      throw new Error(`dominio de playbook no canónico: ${JSON.stringify(pb.domain)}`);
    }
    const invalid = validatePlaybook(pb);
    if (invalid) throw new Error(invalid);
    const tmp = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, renderPlaybook(pb), { encoding: 'utf8', flag: 'wx' });
      renameSync(tmp, this.#path(pb.domain));
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}
