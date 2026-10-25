/**
 * Cola de revision de contradicciones: un JSON pequeno, atomico y acotado.
 *
 * La memoria no debe decidir sola entre dos versiones incompatibles del mismo
 * hecho ("vive en Madrid" / "no vive en Madrid"): fusionarlas borraria una de
 * las dos y elegir la "mas reciente" puede ser exactamente lo contrario de lo
 * que el usuario queria. En vez de eso se apunta la pareja aqui, se conservan
 * ambas balas y el usuario (o una pasada de revision) decide con `keepId`.
 *
 * Decisiones:
 * - `append` valida los textos y escribe siempre con tmp + rename: un corte a
 *   medias deja intacta la cola anterior, nunca un JSON truncado.
 * - Tope de 100: al entrar una nueva sale la mas antigua. La cola es una
 *   bandeja de pendientes, no un archivo historico.
 * - `list` nunca lanza: un fichero ausente, vacio o corrupto se lee como cola
 *   vacia, igual que el resto de la memoria. La siguiente escritura lo repara.
 * - `resolve` elimina la entrada y deja en el log que hecho se decidio
 *   conservar; no toca memoria ni perfil por su cuenta (eso es del llamador).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.js';
import { foldText, tokenJaccard } from './consolidate.js';

/** Tope de la bandeja: lo mas antiguo se descarta al entrar una nueva. */
export const REVIEW_MAX_ITEMS = 100;
/** Solape lexico minimo para considerar que dos textos hablan del mismo hecho. */
export const CONTRADICTION_OVERLAP = 0.6;

const NEGATION_RE = /(?:^|[^\p{L}\p{N}])(?:no|nunca|jamas)(?=$|[^\p{L}\p{N}])/u;

/** Una pareja pendiente de revision. `aId`/`bId` son los ids de memoria, si los hay. */
export interface ReviewItem {
  id: string;
  a: string;
  b: string;
  aId?: string;
  bId?: string;
  note?: string;
  createdAt: string;
}

export interface ReviewItemInput {
  id?: string;
  a: string;
  b: string;
  aId?: string;
  bId?: string;
  note?: string;
  createdAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`La contradiccion necesita ${label} de texto`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`La contradiccion necesita ${label} no vacio`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function cleanTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function newReviewId(): string {
  return `rv-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** Todo lo que entra pasa por aqui; lo que falte se descarta sin romper la cola. */
function parseItem(value: unknown): ReviewItem | null {
  if (!isRecord(value)) return null;
  const id = optionalText(value.id);
  const a = optionalText(value.a);
  const b = optionalText(value.b);
  if (!id || !a || !b) return null;
  const item: ReviewItem = {
    id,
    a,
    b,
    createdAt: cleanTimestamp(value.createdAt) ?? new Date(0).toISOString(),
  };
  const aId = optionalText(value.aId);
  const bId = optionalText(value.bId);
  const note = optionalText(value.note);
  if (aId) item.aId = aId;
  if (bId) item.bId = bId;
  if (note) item.note = note;
  return item;
}

/** Dos textos se contradicen si la polaridad difiere y comparten suficiente lexico. */
export function isContradiction(a: string, b: string): boolean {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  if (!foldText(left) || !foldText(right)) return false;
  const leftNegated = NEGATION_RE.test(foldText(left));
  const rightNegated = NEGATION_RE.test(foldText(right));
  if (leftNegated === rightNegated) return false;
  return tokenJaccard(left, right) >= CONTRADICTION_OVERLAP;
}

/**
 * Lee la cola. Devuelve [] ante ausencia, JSON roto o entradas invalidas: una
 * contradiccion mal escrita no debe impedir ver las demas ni tumbar el turno.
 */
export function list(path: string): ReviewItem[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items = parsed.map(parseItem).filter((item): item is ReviewItem => item !== null);
    return items.slice(-REVIEW_MAX_ITEMS);
  } catch (err) {
    log.warn('memory review: cola ilegible, se trata como vacia', { err: String(err) });
    return [];
  }
}

/**
 * tmp + rename en el mismo directorio. El rename sustituye el fichero entero de
 * una vez: quien lea durante la escritura ve la cola anterior o la nueva, nunca
 * una mezcla. El temporal no se reutiliza para que dos procesos no se pisen.
 */
function writeAtomic(path: string, items: readonly ReviewItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch (cleanupError) {
      log.warn('memory review: no se pudo borrar el temporal', { err: String(cleanupError) });
    }
    throw err;
  }
}

/** Encola una pareja. El tope desplaza la entrada mas antigua, no la nueva. */
export function append(path: string, item: ReviewItemInput): ReviewItem {
  const a = cleanText(item?.a, 'el hecho A');
  const b = cleanText(item?.b, 'el hecho B');
  const created: ReviewItem = {
    id: optionalText(item?.id) ?? newReviewId(),
    a,
    b,
    createdAt: cleanTimestamp(item?.createdAt) ?? new Date().toISOString(),
  };
  const aId = optionalText(item?.aId);
  const bId = optionalText(item?.bId);
  const note = optionalText(item?.note);
  if (aId) created.aId = aId;
  if (bId) created.bId = bId;
  if (note) created.note = note;
  writeAtomic(path, [...list(path), created].slice(-REVIEW_MAX_ITEMS));
  return created;
}

/**
 * Marca como revisada la entrada `id` conservando `keepId`. Devuelve true solo
 * si la entrada existia; el llamador es quien aplica la decision a la memoria.
 */
export function resolve(path: string, id: string, keepId: string): boolean {
  const target = typeof id === 'string' ? id.trim() : '';
  const keep = typeof keepId === 'string' ? keepId.trim() : '';
  if (!target || !keep) return false;
  const items = list(path);
  const index = items.findIndex((item) => item.id === target);
  if (index < 0) return false;
  const [removed] = items.splice(index, 1);
  writeAtomic(path, items);
  log.info('memory review: contradiccion resuelta', {
    id: target,
    keepId: keep,
    aId: removed?.aId ?? null,
    bId: removed?.bId ?? null,
  });
  return true;
}

/** Vacia la cola conservando el fichero (escritura atomica). Devuelve cuantas salieron. */
export function clear(path: string): number {
  if (!existsSync(path)) return 0;
  const removed = list(path).length;
  writeAtomic(path, []);
  return removed;
}
