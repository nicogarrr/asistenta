/**
 * Consolidacion nocturna de memoria: fusiona duplicados y resume, a mano y
 * con copia recuperable, nunca inventando datos.
 *
 * El problema: cada hecho duradero entra como una bala nueva (memory.ts) y los
 * hechos auto-guardados del perfil (usermodel.ts) se anaden solos. Al cabo de
 * semanas el mismo hecho aparece 3 veces con distinta redaccion, el recall
 * devuelve ruido repetido y PERFIL.md gasta su presupuesto en copias.
 *
 * Lo que hace una pasada:
 *
 * 1. Copia de seguridad recuperable ANTES de tocar nada: cada fichero que se
 *    va a modificar se copia intacto a `<backupDir>/<fecha>/`. La consolidacion
 *    nunca borra sin esa copia; ademas, en los scopes de memoria la fusion usa
 *    `supersedes`, asi que las balas viejas quedan en el propio fichero,
 *    auditables, solo ocultas al recall.
 * 2. Agrupa duplicados dentro de cada scope: texto identico salvo acentos y
 *    mayusculas, uno contenido en otro, o solape de tokens alto (Jaccard). Con
 *    embedder (PA_SEMANTIC_RECALL=1) tambien une parafrais por coseno; sin el
 *    la pasada es 100% determinista y sigue funcionando.
 * 3. Fusiona: se queda el texto canonico (el mas reciente; a igual fecha, el
 *    mas completo) y crea una bala nueva que supersede a las demas con la
 *    etiqueta `consolidada`. El texto siempre es una de las balas originales:
 *    resumir aqui es elegir y juntar, no parafrasear — parafrasear con un
 *    modelo podria inventar, y una memoria que inventa es peor que una
 *    repetida.
 * 4. PERFIL.md se deduplica igual por su API publica (load/removeEntries/
 *    appendEntry), con la misma copia previa.
 *
 * Opt-in por PA_MEMORY_CONSOLIDATE=1 y enganchada al tick de 10 minutos como
 * el backup de las 03:00: sin la flag, el comportamiento es exactamente el de
 * antes.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { wallClock } from '../datecontext.js';
import { log } from '../log.js';
import type { MemoryEntry, MemoryStore } from '../memory.js';
import type { Embedder } from './semantic.js';
import { cosine } from './semantic.js';
import { ENTRY_SEPARATOR, type MemorySnapshot } from './snapshot.js';

/** Etiqueta que llevan las balas creadas por una fusion. */
export const CONSOLIDATE_TAG = 'consolidada';
/** Solape de tokens (Jaccard) a partir del cual dos balas son el mismo hecho. */
export const JACCARD_THRESHOLD = 0.8;
/** Coseno minimo para unir parafrais cuando hay embedder. Alto a proposito. */
export const COSINE_THRESHOLD = 0.92;
/** Longitud minima para la regla de "uno contiene al otro". */
const CONTAIN_MIN = 12;
/** Cada dia a partir de las 03:00 locales, una vez cada 20 h (como el backup). */
const DAY_MS = 24 * 3_600_000;
/** Hora local en la que se abre la ventana diaria de consolidacion. */
export const CONSOLIDATION_DAILY_HOUR = 4;
/** Solape minimo del predicado para considerar que dos balas hablan de lo mismo. */
const POLARITY_OVERLAP = 0.6;
/** Marcadores de negacion reconocidos (siempre sobre texto plegado). */
const NEGATION_WORDS = new Set(['no', 'nunca', 'jamas']);

export function isConsolidationDue(now: Date, lastRunMs: number): boolean {
  return wallClock(now).hour >= 3 && now.getTime() - lastRunMs > DAY_MS - 4 * 3_600_000;
}

/** Inicio de la ventana diaria en hora local, no en UTC. */
function dailyWindowStart(now: Date): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    CONSOLIDATION_DAILY_HOUR,
  ).getTime();
}

/**
 * La ventana diaria ya esta abierta (por defecto, desde las 04:00 locales).
 * Por si sola no sabe si hoy ya se ejecuto: eso lo decide consolidationDue.
 */
export function shouldConsolidateDaily(now: Date): boolean {
  return now.getTime() >= dailyWindowStart(now);
}

/**
 * Toca consolidar hoy. Sin ejecucion previa, en cuanto se abre la ventana;
 * con ella, solo si la ultima pasada fue antes de la ventana de hoy. Asi una
 * caida a las 04:05 se recupera esa misma manana y no se repite en el dia.
 */
export function consolidationDue(lastRunMs: number | undefined, now: Date): boolean {
  if (!shouldConsolidateDaily(now)) return false;
  if (lastRunMs === undefined || !Number.isFinite(lastRunMs)) return true;
  return lastRunMs < dailyWindowStart(now);
}

/** Misma normalizacion en todo el modulo: acentos, mayusculas y espacios fuera. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    foldText(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1),
  );
}

export function tokenJaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

interface NegationSplit {
  negated: boolean;
  /** Texto plegado sin los marcadores de negacion. */
  core: string;
}

/** Separa una bala en "niega / no niega" y el predicado que queda. */
function splitNegation(text: string): NegationSplit {
  const folded = foldText(text);
  const parts = folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
  const negated = parts.some((token) => NEGATION_WORDS.has(token));
  if (!negated) return { negated: false, core: folded };
  return {
    negated: true,
    core: parts.filter((token) => !NEGATION_WORDS.has(token)).join(' '),
  };
}

/** Mismo predicado: igual, contenido o con solape de tokens suficiente. */
function sharesPredicate(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= CONTAIN_MIN && b.length >= CONTAIN_MIN && (a.includes(b) || b.includes(a))) {
    return true;
  }
  return tokenJaccard(a, b) >= POLARITY_OVERLAP;
}

/**
 * Una bala afirma y la otra niega el mismo predicado ("vive en Madrid" /
 * "no vive en Madrid", "nunca come carne" / "come carne"). Son informacion
 * distinta, no un duplicado: fusionarlas borraria una de las dos versiones.
 */
export function isPolarityConflict(a: string, b: string): boolean {
  const left = splitNegation(a);
  const right = splitNegation(b);
  if (left.negated === right.negated) return false;
  const negated = left.negated ? left : right;
  const affirmative = left.negated ? right : left;
  return sharesPredicate(negated.core, affirmative.core);
}

/** Duplicado lexico: identicas plegadas, contenidas o con solape de tokens alto. */
export function lexicalDuplicate(a: string, b: string): boolean {
  const fa = foldText(a);
  const fb = foldText(b);
  if (!fa || !fb) return false;
  // Una contradiccion no es un duplicado: se conservan las dos versiones.
  if (isPolarityConflict(fa, fb)) return false;
  if (fa === fb) return true;
  if (
    fa.length >= CONTAIN_MIN &&
    fb.length >= CONTAIN_MIN &&
    (fa.includes(fb) || fb.includes(fa))
  ) {
    return true;
  }
  return tokenJaccard(a, b) >= JACCARD_THRESHOLD;
}

export interface DuplicateGroup<T> {
  /** Indice (dentro del array de entrada) de la bala canonica que se queda. */
  canonical: number;
  /** Indices de las balas que la fusion absorbe. */
  absorbed: number[];
  /** Referencia al item canonico, comoda para el llamador. */
  item: T;
}

interface Groupable {
  text: string;
  date: string;
  supersededBy: string | null;
}

/**
 * El canonico de un grupo: la bala mas reciente; a igual fecha, la de texto
 * mas largo (la mas completa). Nunca una mezcla: el texto ganador existe ya.
 */
function pickCanonical<T extends Groupable>(items: T[], indices: number[]): number {
  let best = indices[0] ?? 0;
  for (const i of indices) {
    const cur = items[i];
    const win = items[best];
    if (!cur || !win) continue;
    if (cur.date > win.date || (cur.date === win.date && cur.text.length > win.text.length)) {
      best = i;
    }
  }
  return best;
}

/**
 * Agrupa las balas que dicen lo mismo. Union-find sobre pares duplicados:
 * si A~B y B~C, las tres viajan juntas aunque A y C difieran mas del umbral.
 * Las balas ya superseded no entran: estan ocultas al recall y su historia no
 * se toca. Sin embedder es determinista; con embedder, el coseno alto une
 * ademas parafrais.
 */
export async function groupDuplicates<T extends Groupable>(
  items: readonly T[],
  opts: { embedder?: Embedder; cosineThreshold?: number } = {},
): Promise<DuplicateGroup<T>[]> {
  const live: number[] = [];
  for (const [i, item] of items.entries()) {
    if (item.supersededBy === null) live.push(i);
  }
  const parent = new Map<number, number>(live.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: number, b: number): void => {
    parent.set(find(a), find(b));
  };

  const vectors = new Map<number, number[]>();
  if (opts.embedder && live.length > 1) {
    try {
      const embe = await opts.embedder.embed(live.map((i) => items[i]?.text ?? ''));
      live.forEach((idx, k) => {
        const v = embe[k];
        if (v) vectors.set(idx, v);
      });
    } catch (err) {
      // Sin vectores la pasada sigue con lo lexico: nunca se rompe por el modelo.
      log.warn('memory consolidation: embedder failed, falling back to lexical', {
        err: String(err),
      });
    }
  }
  const threshold = opts.cosineThreshold ?? COSINE_THRESHOLD;

  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const ia = live[a] ?? 0;
      const ib = live[b] ?? 0;
      const ta = items[ia]?.text ?? '';
      const tb = items[ib]?.text ?? '';
      // La guarda de polaridad manda sobre lexico y coseno: dos versiones
      // contradictorias del mismo hecho se quedan ambas, aunque el modelo las
      // vea casi identicas.
      if (isPolarityConflict(ta, tb)) continue;
      let dup = lexicalDuplicate(ta, tb);
      if (!dup) {
        const va = vectors.get(ia);
        const vb = vectors.get(ib);
        if (va && vb && cosine(va, vb) >= threshold) dup = true;
      }
      if (dup) union(ia, ib);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (const i of live) {
    const root = find(i);
    byRoot.set(root, [...(byRoot.get(root) ?? []), i]);
  }
  const groups: DuplicateGroup<T>[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const canonical = pickCanonical(items as T[], members);
    groups.push({
      canonical,
      absorbed: members.filter((i) => i !== canonical),
      item: items[canonical] as T,
    });
  }
  return groups;
}

export interface ConsolidateScopeResult {
  scope: string;
  /** Balas absorbidas (quedan en el fichero, marcadas superseded). */
  merged: number;
  /** Balas nuevas creadas por fusion. */
  created: number;
}

/**
 * Aplica los grupos ya calculados: una bala nueva con el texto canonico que
 * supersede a TODAS las del grupo, canonica incluida. Si la canonica se
 * quedara viva junto a la fusionada, serian dos balas identicas vivas y la
 * siguiente pasada las volveria a fusionar: la fusion sustituye al grupo
 * entero, no solo a las absorbidas.
 */
export function applyScopeGroups(
  store: MemoryStore,
  scope: string,
  entries: readonly MemoryEntry[],
  groups: readonly DuplicateGroup<MemoryEntry>[],
): ConsolidateScopeResult {
  let merged = 0;
  let created = 0;
  for (const group of groups) {
    const canonical = entries[group.canonical];
    if (!canonical) continue;
    const members = [group.canonical, ...group.absorbed]
      .map((i) => entries[i])
      .filter((e): e is MemoryEntry => e !== undefined);
    if (members.length < 2) continue;
    const tags = [...new Set([...members.flatMap((e) => e.tags), CONSOLIDATE_TAG])];
    try {
      store.remember(scope, canonical.text, {
        tags,
        supersedes: members.map((e) => e.id),
      });
      merged += members.length;
      created += 1;
    } catch (err) {
      // Una fusion que falla no frena las demas: se deja como estaba y se anota.
      log.warn('memory consolidation: merge failed', { scope, err: String(err) });
    }
  }
  return { scope, merged, created };
}

/**
 * Fusiona los duplicados de un scope. Nada se borra: cada bala absorbida
 * queda en el fichero con `superseded-by`, y el llamador ya hizo copia del
 * fichero intacto antes de llamar aqui.
 */
export async function consolidateScope(
  store: MemoryStore,
  scope: string,
  opts: { embedder?: Embedder } = {},
): Promise<ConsolidateScopeResult> {
  const entries = store.all(scope);
  const groups = await groupDuplicates(entries, opts);
  return applyScopeGroups(store, scope, entries, groups);
}

export interface ConsolidateProfileResult {
  removed: number;
  appended: number;
}

/**
 * Deduplica PERFIL.md por su API publica. La copia recuperable la hace el
 * llamador antes de entrar. Si appendEntry rechaza el canonico (parece un
 * secreto), ese grupo se queda como estaba: mejor repetido que reescrito.
 */
export async function consolidateProfile(
  snapshot: MemorySnapshot,
  opts: { embedder?: Embedder } = {},
): Promise<ConsolidateProfileResult> {
  const entries = snapshot
    .load()
    .split(ENTRY_SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const asGroupable = entries.map((text) => ({ text, date: '', supersededBy: null }));
  const groups = await groupDuplicates(asGroupable, opts);
  let removed = 0;
  let appended = 0;
  for (const group of groups) {
    const canonical = entries[group.canonical];
    if (!canonical) continue;
    // Se quita el grupo entero (canonica incluida) y se anade una sola copia:
    // dejar la canonica viva junto a la anadida crearia el duplicado otra vez.
    // Orden: primero las absorbidas por si alguna CONTIENE a la canonica (ese
    // removeEntries ya se la llevaria), luego la canonica.
    const memberTexts = [
      ...new Set(
        [...group.absorbed, group.canonical]
          .map((i) => entries[i])
          .filter((t): t is string => typeof t === 'string'),
      ),
    ];
    if (memberTexts.length < 2) continue;
    const gone = memberTexts.reduce((acc, t) => acc + snapshot.removeEntries(t), 0);
    if (gone === 0) continue;
    const saved = snapshot.appendEntry(canonical);
    if (!saved.ok) {
      log.warn('memory consolidation: profile re-append refused', { reason: saved.reason });
      continue;
    }
    removed += gone;
    appended += 1;
  }
  return { removed, appended };
}

export interface ConsolidationReport {
  scopes: ConsolidateScopeResult[];
  profile: ConsolidateProfileResult;
  /** Copias recuperables escritas antes de modificar (rutas absolutas). */
  backups: string[];
  skippedScopes: string[];
}

function dayStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Una pasada completa: copia recuperable de todo lo que pueda cambiar, luego
 * fusiona scope a scope y el perfil. Si no hay duplicados en un fichero, ese
 * fichero no se copia ni se toca.
 */
export async function runConsolidation(opts: {
  store: MemoryStore;
  snapshot: MemorySnapshot;
  /** Raiz de las copias recuperables, p.ej. `<stateDir>/memory-consolidation`. */
  backupDir: string;
  embedder?: Embedder;
  now?: Date;
}): Promise<ConsolidationReport> {
  const now = opts.now ?? new Date();
  const dest = join(opts.backupDir, dayStamp(now));
  mkdirSync(dest, { recursive: true });
  const backups: string[] = [];
  const report: ConsolidationReport = {
    scopes: [],
    profile: { removed: 0, appended: 0 },
    backups,
    skippedScopes: [],
  };

  const backup = (file: string): void => {
    if (!existsSync(file)) return;
    // Nunca pisar una copia ya hecha: con la regla de 20 h puede haber dos pasadas el
    // mismo día (03:00 y 23:00) y la segunda sobrescribía la copia ORIGINAL de la
    // primera con el fichero ya consolidado. Tampoco un scope que se llame como
    // PERFIL.md puede pisar la del perfil.
    let target = join(dest, basename(file));
    for (let n = 1; existsSync(target); n++) target = join(dest, `${basename(file)}.${n}`);
    copyFileSync(file, target);
    backups.push(target);
  };

  for (const scope of opts.store.scopes()) {
    const entries = opts.store.all(scope);
    const groups = await groupDuplicates(entries, { embedder: opts.embedder });
    if (groups.length === 0) {
      report.skippedScopes.push(scope);
      continue;
    }
    // Copia recuperable ANTES de tocar el fichero, siempre.
    backup(opts.store.fileFor(scope));
    const result = applyScopeGroups(opts.store, scope, entries, groups);
    if (result.created === 0) {
      report.skippedScopes.push(scope);
      continue;
    }
    report.scopes.push(result);
  }

  const profileFile = join(opts.snapshot.dir, 'PERFIL.md');
  const profileEntries = opts.snapshot
    .load()
    .split(ENTRY_SEPARATOR)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const profileGroups = await groupDuplicates(
    profileEntries.map((text) => ({ text, date: '', supersededBy: null })),
    { embedder: opts.embedder },
  );
  if (profileGroups.length > 0 && existsSync(profileFile)) {
    // Misma regla: copia recuperable antes del primer cambio.
    backup(profileFile);
    report.profile = await consolidateProfile(opts.snapshot, { embedder: opts.embedder });
  }

  log.info('memory consolidation done', {
    scopes: report.scopes.length,
    merged: report.scopes.reduce((a, s) => a + s.merged, 0),
    created: report.scopes.reduce((a, s) => a + s.created, 0),
    profileRemoved: report.profile.removed,
    backups: backups.length,
  });
  return report;
}
