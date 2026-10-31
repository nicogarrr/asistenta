/**
 * One SKILL.md per skill, under `skills/<id>/SKILL.md`.
 *
 * The store exists to make learned knowledge *editable*. A database row cannot
 * be fixed by the user at 2am when the agent keeps doing the wrong thing; a
 * Markdown file can. So a skill is YAML frontmatter plus two Markdown sections
 * (`## Steps`, `## Notes`) and nothing else, and every write round-trips through
 * that format instead of a private in-memory shape.
 *
 * Two rules the format enforces by construction:
 *
 * 1. A step is always one line. A parser that accepted multi-line steps would
 *    make "one step" and "half a step" indistinguishable after a bad edit.
 * 2. `improve` never destroys history. Replaced steps are written into
 *    `## Notes` as a bracketed diff, so the reason a recipe changed is still
 *    readable months later — a skill that silently rewrites itself is a skill
 *    nobody can trust.
 *
 * The YAML here is a deliberately small subset (flat `key: value` pairs). The
 * fields are flat scalars by design; quoting is applied on write whenever a
 * value could be ambiguous, so a plain YAML reader and this parser agree.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { localDay } from '../datecontext.js';
import { uniqueTmpPath } from '../fs-tmp.js';
import { log } from '../log.js';
import { foldAccents } from '../text.js';
import type { Skill, SkillDraft, SkillTrust } from './types.js';

export const SKILL_FILENAME = 'SKILL.md';
/** Papelera de skills borradas: empieza por punto, así list() nunca la toma por un id. */
export const TRASH_DIR = '.papelera';

/** Slug-shaped ids only: they double as directory names, so no separators, no dots. */
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 64;

/**
 * Plain YAML scalar: no `:` or `#` (both would be read as structure by another
 * YAML parser), no quotes, no braces. Anything else gets double-quoted on write.
 */
const YAML_PLAIN_SAFE = /^[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F .,()/¿?¡!+&%_-]*$/;

/** Steps cap per improve note: the diff must stay readable in one glance. */
const MAX_NOTE_MARKERS = 8;

export function isSkillId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && SKILL_ID.test(id);
}

/** Name to directory id. Idempotent, accent-insensitive, and collision-visible. */
export function slugify(name: string): string {
  const slug = foldAccents(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
  return slug || 'skill';
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function quoteYaml(value: string): string {
  const flat = oneLine(value);
  if (flat !== '' && YAML_PLAIN_SAFE.test(flat)) return flat;
  return `"${flat.replace(/([\\"])/g, '\\$1')}"`;
}

function unquoteYaml(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return value;
}

function parseTs(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function today(): string {
  return localDay();
}

function splitFrontmatter(markdown: string): { meta: Map<string, string>; body: string } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const meta = new Map<string, string>();
  let start = 0;
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++;
  if ((lines[start] ?? '').trim() !== '---') return { meta, body: lines.join('\n') };
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  // An unterminated block is not frontmatter: a half-written file must not be
  // read as "a skill with no name".
  if (end < 0) return { meta, body: lines.join('\n') };
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] ?? '';
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquoteYaml(line.slice(colon + 1).trim());
    if (key) meta.set(key, value);
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

function toTrust(value: string | undefined): SkillTrust {
  return value === 'official' || value === 'trusted' || value === 'community' ? value : 'community';
}

/** Strip one bullet or numbering prefix so `save` and hand edits read the same. */
function stripBullet(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

/**
 * Tolerant parse: a heading it does not know (`## Tips`) is folded into notes
 * rather than dropped, because silently losing what someone wrote by hand is
 * how an agent's "memory" turns into a lie.
 */
export function parseSkillMarkdown(id: string, markdown: string): Skill {
  const { meta, body } = splitFrontmatter(markdown);
  const steps: string[] = [];
  const notes: string[] = [];
  let section = 'intro';
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^##\s+(.*)$/.exec(raw.trim());
    if (heading) {
      const title = (heading[1] ?? '').trim().toLowerCase();
      section = title.startsWith('step') || title.startsWith('paso') ? 'steps' : 'notes';
      continue;
    }
    const clean = stripBullet(raw);
    if (!clean) continue;
    if (section === 'steps') steps.push(clean);
    else if (section === 'notes') notes.push(clean);
  }
  const updatedAt = parseTs(meta.get('updated_at')) ?? 0;
  const createdAt = parseTs(meta.get('created_at')) ?? updatedAt;
  const version = Math.max(1, Math.floor(Number(meta.get('version')) || 1));
  return {
    id,
    name: meta.get('name') ?? id,
    description: meta.get('description') ?? '',
    category: meta.get('category') ?? 'general',
    whenToUse: meta.get('when_to_use') ?? '',
    steps,
    notes,
    version,
    createdAt,
    updatedAt,
    trust: toTrust(meta.get('trust')),
    ...optionalMeta(meta),
  };
}

function toList(value: string | undefined): string[] {
  return (value ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => oneLine(item).toLowerCase())
    .filter(Boolean);
}

/** Claves propias opcionales: un lector agentskills estándar las ignora. */
function optionalMeta(meta: Map<string, string>): Partial<Skill> {
  const out: Partial<Skill> = {};
  if (meta.get('disabled') === 'true') out.disabled = true;
  const outward = meta.get('outward');
  if (outward === 'true' || outward === 'false') out.outward = outward === 'true';
  const needs = toList(meta.get('needs'));
  if (needs.length > 0) out.needs = needs;
  const tool = oneLine(meta.get('tool') ?? '');
  if (tool) out.tool = tool;
  return out;
}

export function serializeSkillMarkdown(skill: Skill): string {
  const out = [
    '---',
    `name: ${quoteYaml(skill.name)}`,
    `description: ${quoteYaml(skill.description)}`,
    `category: ${quoteYaml(skill.category)}`,
    `when_to_use: ${quoteYaml(skill.whenToUse)}`,
    `trust: ${quoteYaml(skill.trust)}`,
    `version: ${skill.version}`,
    `created_at: ${quoteYaml(new Date(skill.createdAt).toISOString())}`,
    `updated_at: ${quoteYaml(new Date(skill.updatedAt).toISOString())}`,
  ];
  if (skill.disabled) out.push('disabled: true');
  if (skill.outward !== undefined) out.push(`outward: ${skill.outward}`);
  if (skill.needs && skill.needs.length > 0)
    out.push(`needs: ${quoteYaml(skill.needs.join(', '))}`);
  if (skill.tool) out.push(`tool: ${quoteYaml(skill.tool)}`);
  out.push('---', '', '## Steps', '');
  for (const step of skill.steps) out.push(`- ${oneLine(step)}`);
  if (skill.notes.length > 0) {
    out.push('', '## Notes', '');
    for (const note of skill.notes) out.push(`- ${oneLine(note)}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Lexical scoring on name, description and whenToUse — the three fields a
 * request can be matched against without reading the whole recipe. No vector
 * search: at personal-agent scale it would add a model, a bill, and a
 * similarity nobody can argue with when it picks the wrong skill.
 */
export function scoreSkill(skill: Skill, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const name = skill.name.toLowerCase();
  const haystack = `${skill.name} ${skill.description} ${skill.whenToUse}`.toLowerCase();
  let score = haystack.includes(needle) ? 4 : 0;
  if (name.includes(needle)) score += 2;
  for (const token of needle.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1)) {
    if (haystack.includes(token)) score += 1;
    if (name.includes(token)) score += 1;
  }
  return score;
}

/** Bracketed diff: the whole point is that removed steps stay visible. */
export function buildChangeNote(
  reason: string,
  date: string,
  version: number,
  oldSteps: string[],
  newSteps: string[],
): string {
  const markers: string[] = [];
  for (const step of oldSteps) if (!newSteps.includes(step)) markers.push(`[-] ${oneLine(step)}`);
  for (const step of newSteps) if (!oldSteps.includes(step)) markers.push(`[+] ${oneLine(step)}`);
  const shown = markers.slice(0, MAX_NOTE_MARKERS);
  const hidden = markers.length - shown.length;
  const diff = shown.length > 0 ? ` ${shown.join(' ')}` : '';
  const more = hidden > 0 ? ` ... y ${hidden} cambios mas` : '';
  return `(${date}, v${version}) ${reason}${diff}${more}`;
}

export interface SkillStoreOptions {
  /** Directory whose subdirectories are the skills. Created if missing. */
  dir: string;
}

export class SkillStore {
  readonly dir: string;

  constructor(opts: SkillStoreOptions) {
    this.dir = opts.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  fileFor(id: string): string {
    return join(this.dir, id, SKILL_FILENAME);
  }

  /** Every skill, sorted by id so listings do not reshuffle between calls. */
  list(): Skill[] {
    const out: Skill[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!isSkillId(name)) continue;
      const file = this.fileFor(name);
      if (!existsSync(file)) continue;
      try {
        out.push(parseSkillMarkdown(name, readFileSync(file, 'utf8')));
      } catch (err) {
        // One broken file must not hide the rest: list feeds search and the
        // tool overview, where failing the whole call would look like "no
        // skills at all" and the agent would relearn what it already knows.
        log.warn('skill unreadable, skipped', { id: name, err });
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Null for unknown or hostile ids; read errors propagate like MemoryStore. */
  read(id: string): Skill | null {
    if (!isSkillId(id)) return null;
    const file = this.fileFor(id);
    if (!existsSync(file)) return null;
    return parseSkillMarkdown(id, readFileSync(file, 'utf8'));
  }

  /** Create or update by slug of the name; editing bumps the version. */
  save(draft: SkillDraft): string {
    const name = oneLine(draft.name);
    if (!name) throw new Error('un skill necesita name');
    const steps = draft.steps.map((step) => oneLine(step)).filter(Boolean);
    if (steps.length === 0) throw new Error('un skill necesita al menos un paso en steps');
    const id = slugify(name);
    const now = Date.now();
    const existing = this.read(id);
    const skill: Skill = {
      id,
      name,
      description: oneLine(draft.description),
      category: oneLine(draft.category) || 'general',
      whenToUse: oneLine(draft.whenToUse),
      steps,
      // Existing notes are kept first and deduplicated: save() is also how a
      // note gets fixed, and re-saving the same draft must not stack copies or
      // lose the improve() audit trail.
      notes: [...new Set([...(existing?.notes ?? []), ...(draft.notes ?? [])])],
      version: existing ? existing.version + 1 : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      trust: existing?.trust ?? 'community',
    };
    // Re-guardar no reactiva una skill que el dueño desactivó.
    if (existing?.disabled) skill.disabled = true;
    const outward = draft.outward ?? existing?.outward;
    if (outward !== undefined) skill.outward = outward;
    const needs = (draft.needs ?? existing?.needs ?? [])
      .map((need) => oneLine(need).toLowerCase())
      .filter(Boolean);
    if (needs.length > 0) skill.needs = [...new Set(needs)];
    const tool = oneLine(draft.tool ?? existing?.tool ?? '');
    if (tool) skill.tool = tool;
    this.#write(skill);
    return id;
  }

  /** «quita la de X»: reversible, el fichero se queda. Devuelve false si no existe. */
  setDisabled(id: string, disabled: boolean): boolean {
    const skill = this.read(id);
    if (!skill) return false;
    if (Boolean(skill.disabled) === disabled) return true;
    if (disabled) skill.disabled = true;
    else delete skill.disabled;
    skill.updatedAt = Date.now();
    this.#write(skill);
    return true;
  }

  /**
   * Borrar es mover a `.papelera/<id>-<fecha>` dentro del directorio de skills:
   * recuperable a mano y fuera de list() (los nombres con punto no son ids).
   */
  remove(id: string): boolean {
    if (!isSkillId(id) || !existsSync(this.fileFor(id))) return false;
    const bin = join(this.dir, TRASH_DIR);
    mkdirSync(bin, { recursive: true });
    renameSync(join(this.dir, id), join(bin, `${id}-${Date.now()}`));
    return true;
  }

  /**
   * Replace the steps with the ones that now work, and write why into Notes.
   * Every step that disappears is recorded as `[-]` next to the reason: an
   * improvement that hides what it deleted cannot be reviewed or reverted.
   */
  improve(id: string, newSteps: string[], reason: string): void {
    const skill = this.read(id);
    if (!skill) throw new Error(`no hay ningun skill con id ${id}`);
    const why = oneLine(reason);
    if (!why) throw new Error('improve necesita un reason que justifique el cambio');
    const steps = newSteps.map((step) => oneLine(step)).filter(Boolean);
    if (steps.length === 0) throw new Error('improve necesita al menos un paso en newSteps');
    const version = skill.version + 1;
    const note = buildChangeNote(why, today(), version, skill.steps, steps);
    skill.steps = steps;
    skill.notes = [...skill.notes, note];
    skill.version = version;
    skill.updatedAt = Date.now();
    this.#write(skill);
  }

  search(query: string): Skill[] {
    return this.list()
      .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || (a.skill.id < b.skill.id ? -1 : 1))
      .map((hit) => hit.skill);
  }

  /** The skill as shareable Markdown: exactly what to save as SKILL.md elsewhere. */
  export(id: string): string {
    const skill = this.read(id);
    if (!skill) throw new Error(`no hay ningun skill con id ${id}`);
    return serializeSkillMarkdown(skill);
  }

  /**
   * tmp + rename: a crash mid-write must leave the previous recipe intact
   * rather than a half-written file the parser would read as empty steps.
   */
  #write(skill: Skill): void {
    mkdirSync(join(this.dir, skill.id), { recursive: true });
    const file = this.fileFor(skill.id);
    const tmp = uniqueTmpPath(file);
    writeFileSync(tmp, serializeSkillMarkdown(skill), 'utf8');
    renameSync(tmp, file);
    log.debug('skill written', { id: skill.id, version: skill.version });
  }
}
