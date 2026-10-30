/**
 * Perfil v2: hechos estructurados, uno por propietario y en su propio JSON.
 *
 * PERFIL.md era un bloque de prosa que viajaba entero al prompt. Aquí cada
 * hecho es una entrada con id, etiquetas, procedencia y fecha, de modo que se
 * pueda buscar, corregir y auditar sin reescribir las palabras del usuario. El
 * propietario (a quién pertenece el fichero) lo decide el llamador: este módulo
 * solo conoce la ruta.
 *
 * Reglas que protege el formato:
 * - Un hecho es una sola línea. El prompt lo pinta como una viñeta y una
 *   entrada multilínea rompería el render y la búsqueda.
 * - Lo que parece un secreto no entra. Se rechaza con el motivo, no se redacta
 *   en silencio: reescribir lo que dijo el usuario sería mentirle.
 * - La escritura es tmp + rename. Un corte a medias deja intacto el fichero
 *   anterior en vez de uno corrupto que se leería como "no recuerdo nada".
 * - `update` no borra: crea una versión nueva y marca la anterior con
 *   `supersededBy`. El historial completo queda en `export()`, pero al prompt
 *   solo llegan las vigentes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.js';
import { foldAccents } from '../text.js';
import { looksLikeSecret } from './snapshot.js';

export interface ProfileFact {
  id: string;
  text: string;
  tags: string[];
  source: 'user' | 'assistant' | 'auto';
  updatedAt: string;
  supersededBy: string | null;
}

/** Tope duro del fichero: más allá, la memoria deja de ser un perfil legible. */
export const PROFILE_MAX_FACTS = 200;

const FACT_ID_LENGTH = 10;
const FACT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Todo a una línea, para poder pintar el hecho como una viñeta. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Minúsculas y sin acentos: la búsqueda no debe depender de cómo se escribió. */
function fold(value: string): string {
  return foldAccents(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): value is ProfileFact['source'] {
  return value === 'user' || value === 'assistant' || value === 'auto';
}

/** Etiquetas cortas y sin `#`: se normalizan al entrar y al releer. */
function cleanTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/**
 * Valida una entrada nueva o editada. El texto se devuelve ya recortado; los
 * errores son los que verá el usuario, en español y sin repetir el secreto.
 */
function validateText(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('El texto del perfil no puede estar vacío');
  }
  if (/[\r\n]/.test(raw)) {
    throw new Error('El texto del perfil debe ser una sola línea');
  }
  const text = raw.trim();
  const reason = looksLikeSecret(text);
  if (reason) {
    throw new Error(`El perfil no guarda ${reason}: parece un secreto`);
  }
  return text;
}

/** Un hecho individual tolerante: lo que no tenga forma de hecho se descarta. */
function parseFact(value: unknown): ProfileFact | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!FACT_ID_RE.test(id)) return null;
  const text = typeof value.text === 'string' ? oneLine(value.text) : '';
  if (!text) return null;
  const rawTags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const updatedAt =
    typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt))
      ? new Date(value.updatedAt).toISOString()
      : new Date(0).toISOString();
  const supersededBy =
    typeof value.supersededBy === 'string' && value.supersededBy.trim()
      ? value.supersededBy.trim()
      : null;
  return {
    id,
    text,
    tags: cleanTags(rawTags),
    source: isSource(value.source) ? value.source : 'auto',
    updatedAt,
    supersededBy,
  };
}

/** Acepta el array plano que escribimos y, por compatibilidad, un envoltorio `{facts}`. */
function parseFacts(raw: string): ProfileFact[] {
  const parsed: unknown = JSON.parse(raw);
  let list: unknown[];
  if (Array.isArray(parsed)) list = parsed;
  else if (isRecord(parsed) && Array.isArray(parsed.facts)) list = parsed.facts;
  else return [];
  const facts: ProfileFact[] = [];
  for (const item of list) {
    const fact = parseFact(item);
    if (fact) facts.push(fact);
  }
  return facts;
}

export class OwnerProfile {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * Todos los hechos, vigentes y sustituidos. Un fichero ausente, ilegible o
   * corrupto se trata como un perfil vacío: perder una respuesta es peor que
   * perder un recuerdo. El siguiente `add` aparta el corrupto a
   * `<perfil>.corrupt-<fecha>` (no se pierde) y empieza un perfil nuevo.
   */
  load(): ProfileFact[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      if (!raw.trim()) return [];
      return parseFacts(raw);
    } catch (err) {
      log.warn('perfil v2 ilegible, se trata como vacío', { err: String(err) });
      return [];
    }
  }

  /**
   * Añade un hecho vigente. El id sale de un hash corto del texto, así que el
   * mismo texto no crea duplicados: devuelve el hecho existente y, si hace
   * falta, fusiona las etiquetas nuevas.
   */
  add(text: string, opts: { tags?: string[]; source?: ProfileFact['source'] } = {}): ProfileFact {
    const clean = validateText(text);
    const tags = cleanTags(opts.tags);
    const source = isSource(opts.source) ? opts.source : 'user';
    const facts = this.load();
    const existing = facts.find((fact) => fact.supersededBy === null && fact.text === clean);
    if (existing) {
      const merged = cleanTags([...existing.tags, ...tags]);
      if (!sameTags(merged, existing.tags)) {
        existing.tags = merged;
        existing.updatedAt = new Date().toISOString();
        this.#write(facts);
      }
      return existing;
    }
    const fact: ProfileFact = {
      id: this.#newId(clean, facts),
      text: clean,
      tags,
      source,
      updatedAt: new Date().toISOString(),
      supersededBy: null,
    };
    facts.push(fact);
    this.#evict(facts);
    this.#write(facts);
    return fact;
  }

  /**
   * Corrige un hecho vigente creando una versión nueva. La anterior conserva
   * su texto y su fecha, pero apunta a la nueva con `supersededBy`, de modo que
   * el historial sigue siendo reconstruible. Devuelve null si el id no existe
   * o si ya estaba sustituido.
   */
  update(id: string, patch: { text?: string; tags?: string[] }): ProfileFact | null {
    const facts = this.load();
    const current = facts.find((fact) => fact.id === id && fact.supersededBy === null);
    if (!current) return null;
    const text = patch.text === undefined ? current.text : validateText(patch.text);
    const tags = patch.tags === undefined ? current.tags : cleanTags(patch.tags);
    if (text === current.text && sameTags(tags, current.tags)) return current;
    const next: ProfileFact = {
      id: this.#newId(text, facts),
      text,
      tags,
      source: current.source,
      updatedAt: new Date().toISOString(),
      supersededBy: null,
    };
    current.supersededBy = next.id;
    facts.push(next);
    this.#evict(facts);
    this.#write(facts);
    return next;
  }

  /**
   * Olvida hechos vigentes por id exacto o por subcadena del texto/etiquetas.
   * Las entradas sustituidas son historial y no se tocan: borrar una versión
   * vieja no debe reescribir lo que pasó.
   */
  forget(needle: string): number {
    const raw = typeof needle === 'string' ? needle.trim() : '';
    if (!raw) return 0;
    const folded = fold(raw);
    const facts = this.load();
    const kept: ProfileFact[] = [];
    let removed = 0;
    for (const fact of facts) {
      const matches =
        fact.id === raw ||
        fold(fact.text).includes(folded) ||
        fact.tags.some((tag) => fold(tag).includes(folded));
      if (fact.supersededBy === null && matches) {
        removed++;
        continue;
      }
      kept.push(fact);
    }
    if (removed > 0) {
      this.#write(kept);
      log.info('hechos del perfil olvidados', { removed });
    }
    return removed;
  }

  /** Búsqueda léxica (todas las palabras deben aparecer) solo entre vigentes. */
  search(query: string): ProfileFact[] {
    const folded = fold(typeof query === 'string' ? query : '');
    const tokens = folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
    if (tokens.length === 0) return [];
    return this.load().filter((fact) => {
      if (fact.supersededBy !== null) return false;
      const haystack = fold(`${fact.text} ${fact.tags.join(' ')}`);
      return tokens.every((token) => haystack.includes(token));
    });
  }

  /** Líneas listas para el prompt: `- [id] (fecha) #tags texto`, solo vigentes. */
  render(): string {
    return this.load()
      .filter((fact) => fact.supersededBy === null)
      .map((fact) => {
        const tags = fact.tags.map((tag) => `#${tag}`).join(' ');
        const head = `- [${fact.id}] (${fact.updatedAt.slice(0, 10)})`;
        return tags ? `${head} ${tags} ${fact.text}` : `${head} ${fact.text}`;
      })
      .join('\n');
  }

  /** JSON completo, incluidas las versiones sustituidas. */
  export(): string {
    return this.#serialize(this.load());
  }

  /**
   * Migra el PERFIL.md legado. Parte por `§` y por líneas, porque v2 solo
   * admite hechos de una línea, y salta duplicados exactos contra todo lo que
   * ya existe. No escribe por su cuenta: cada entrada pasa por `add`, que es
   * quien valida secretos y hace la escritura atómica. Devuelve cuántas entraron.
   */
  migrateFromLegacy(text: string): number {
    if (typeof text !== 'string' || !text.trim()) return 0;
    const normalized = text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/^\s*#\s*PERFIL\s*$/im, '');
    const chunks = normalized.replace(/§/g, '\n').split('\n');
    const seen = new Set(this.load().map((fact) => fact.text));
    let added = 0;
    for (const chunk of chunks) {
      const entry = chunk.trim();
      if (!entry || entry.startsWith('#')) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      const reason = looksLikeSecret(entry);
      if (reason) {
        log.warn('entrada legada del perfil descartada por parecer un secreto', { reason });
        continue;
      }
      this.add(entry, { source: 'user' });
      added++;
    }
    return added;
  }

  /** Hash corto y estable; si ya está usado, un sufijo numérico lo desambigua. */
  #newId(text: string, facts: readonly ProfileFact[]): string {
    const base = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, FACT_ID_LENGTH);
    const used = new Set(facts.map((fact) => fact.id));
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix++;
    }
    return id;
  }

  /** Las más antiguas son las primeras: se van por la cabeza del array. */
  #evict(facts: ProfileFact[]): void {
    while (facts.length > PROFILE_MAX_FACTS) {
      const evicted = facts.shift();
      if (!evicted) break;
      log.debug('hecho del perfil desalojado por el tope', { id: evicted.id });
    }
  }

  /**
   * `load()` lee un fichero corrupto como perfil vacío; si a continuación se
   * escribiera encima, todos los hechos que contenía se perderían. Antes de
   * escribir se aparta a `<perfil>.corrupt-<fecha>` para poder recuperarlo.
   */
  #setAsideIfCorrupt(): void {
    let raw: string;
    try {
      if (!existsSync(this.file)) return;
      raw = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      return;
    }
    if (!raw.trim()) return;
    let readable = false;
    try {
      const parsed: unknown = JSON.parse(raw);
      readable = Array.isArray(parsed) || (isRecord(parsed) && Array.isArray(parsed.facts));
    } catch {
      readable = false;
    }
    if (readable) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.file}.corrupt-${stamp}-${randomBytes(2).toString('hex')}`;
    try {
      renameSync(this.file, backup);
    } catch (err) {
      log.warn('perfil v2 corrupto y no se pudo apartar; no se sobrescribe', { err: String(err) });
      throw new Error('El perfil está corrupto y no se pudo apartar; no se sobrescribe');
    }
    log.warn('perfil v2 corrupto apartado antes de escribir', { backup });
  }

  #serialize(facts: ProfileFact[]): string {
    return `${JSON.stringify(facts, null, 2)}\n`;
  }

  /**
   * tmp + rename en el mismo directorio: el rename es atómico y, si el proceso
   * muere antes, el fichero anterior sigue completo. El temporal no se reutiliza
   * para que dos instancias no puedan pisarse a mitad de escritura.
   */
  #write(facts: ProfileFact[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    this.#setAsideIfCorrupt();
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, this.#serialize(facts), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch (cleanupError) {
        log.warn('no se pudo borrar el temporal del perfil', { err: String(cleanupError) });
      }
      throw err;
    }
    log.debug('perfil v2 escrito', { facts: facts.length });
  }
}
