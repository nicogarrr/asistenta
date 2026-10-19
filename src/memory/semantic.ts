/**
 * S5 - recall semantico de memoria, skills y lecciones (indice vectorial local).
 *
 * La busqueda lexica (scoreEntry / scoreSkill) solo acierta cuando la consulta
 * repite las palabras exactas de la nota; el bench 9a midio 0% de acierto en
 * entradas antiguas. Este modulo reordena con embeddings locales: el modelo
 * multilingual MiniLM corre en onnxruntime-node (el mismo runtime que Whisper
 * en stt.ts), asi que cuesta 0 y ningun texto sale de la maquina.
 *
 * Decisiones deliberadas:
 *
 * - Hibrido, nunca sustituto: la puntuacion final es lexico + peso*coseno. Lo
 *   lexico sigue mandando en coincidencias exactas y el coseno solo rescata lo
 *   parafraseado. Si el embedder falla (modelo sin descargar, nativo roto),
 *   el llamador cae a lexico y el recall nunca se rompe.
 * - Opt-in por PA_SEMANTIC_RECALL=1: la primera descarga del modelo tarda y
 *   no debe bloquear un chat que hoy es instantaneo. Activado, el embedder se
 *   carga perezoso en el primer recall y se memoiza para todo el proceso.
 * - Cache LRU en memoria por hash del texto: releer lo ya embebido es gratis
 *   y el vector nunca se escribe a disco junto al texto (los vectores no son
 *   secretos, pero no hace falta otra copia de nada).
 */
import { createHash } from 'node:crypto';
import { log } from '../log.js';

/** Modelo multilingue pequeno (es/en), cuantizado q8, CPU. */
export const SEMANTIC_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
/**
 * Peso del coseno frente al lexico: scoreEntry da 4 por substring exacto y +1
 * por token, asi que una similitud 1.0 equivale a una mencion literal completa
 * y el lexico gana los empates.
 */
export const SEMANTIC_WEIGHT = 4;
/** Techo de la cache de vectores en memoria (LRU por insercion). */
export const EMBED_CACHE_MAX = 500;
/** Candidatos que se reordenan por consulta; acota la latencia del embed. */
export const SEMANTIC_CANDIDATES = 200;

export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const vectorCache = new Map<string, number[]>();

/** Visible for tests: empties the process-wide vector cache. */
export function clearEmbedCache(): void {
  vectorCache.clear();
}

function cacheKey(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

async function embedCached(embedder: Embedder, texts: readonly string[]): Promise<number[][]> {
  const out: (number[] | null)[] = texts.map((t) => vectorCache.get(cacheKey(t)) ?? null);
  const missing: { idx: number; text: string }[] = [];
  out.forEach((v, i) => {
    if (v === null) missing.push({ idx: i, text: texts[i] ?? '' });
  });
  if (missing.length > 0) {
    const fresh = await embedder.embed(missing.map((m) => m.text));
    if (fresh.length !== missing.length) {
      throw new Error(`embedder devolvio ${fresh.length} vectores para ${missing.length}`);
    }
    for (const [j, m] of missing.entries()) {
      const vec = fresh[j];
      if (!vec) throw new Error('embedder devolvio un vector vacio');
      const key = cacheKey(m.text);
      if (vectorCache.size >= EMBED_CACHE_MAX) {
        const oldest = vectorCache.keys().next();
        if (!oldest.done) vectorCache.delete(oldest.value);
      }
      vectorCache.set(key, vec);
      out[m.idx] = vec;
    }
  }
  return out.map((v) => v ?? []);
}

export interface HybridRankOptions<T> {
  query: string;
  items: readonly T[];
  /** Text that represents the item for both scorings. */
  text: (item: T) => string;
  /** The existing lexical scorer; must agree with today's ranking. */
  lexical: (item: T, query: string) => number;
  embedder: Embedder;
  limit: number;
}

/**
 * Reordena `items` con lexico + coseno. Solo devuelve score > 0, como el
 * recall lexico actual. Empates: gana el item mas reciente (indice mayor),
 * el mismo desempate que MemoryStore.recall.
 */
export async function hybridRank<T>(opts: HybridRankOptions<T>): Promise<T[]> {
  const { query, items, text, lexical, embedder, limit } = opts;
  if (items.length === 0) return [];
  const capped = items.length > SEMANTIC_CANDIDATES ? items.slice(-SEMANTIC_CANDIDATES) : items;
  const texts = capped.map(text);
  const [qv, ...iv] = await embedCached(embedder, [query, ...texts]);
  if (!qv) return [];
  const scored = capped.map((item, index) => ({
    item,
    index,
    score: lexical(item, query) + SEMANTIC_WEIGHT * Math.max(0, cosine(qv, iv[index] ?? [])),
  }));
  return scored
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map((hit) => hit.item);
}

/** Tipo estructural del pipeline: el import pesado queda dentro de la funcion. */
type FeaturePipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: readonly number[] }>;

/**
 * Embedder local perezoso: el modelo se descarga a `modelsDir` en el primer
 * uso (igual que Whisper en stt.ts) y el pipeline se memoiza process-wide.
 */
export function createLocalEmbedder(modelsDir: string, model = SEMANTIC_MODEL): Embedder {
  let pipePromise: Promise<FeaturePipeline> | null = null;
  const getPipe = (): Promise<FeaturePipeline> => {
    if (!pipePromise) {
      pipePromise = (async () => {
        const { LogLevel, env, pipeline } = await import('@huggingface/transformers');
        env.cacheDir = modelsDir;
        env.logLevel = LogLevel.ERROR;
        log.info('semantic recall: cargando embeddings locales', { model });
        return (await pipeline('feature-extraction', model, {
          dtype: 'q8',
          device: 'cpu',
        })) as unknown as FeaturePipeline;
      })();
      // Un fallo de descarga no debe quedar memoizado: el siguiente recall reintenta.
      pipePromise.catch(() => {
        pipePromise = null;
      });
    }
    return pipePromise;
  };
  return {
    embed: async (texts) => {
      const clean = texts.map((t) => (t.trim() ? t : ' '));
      if (clean.length === 0) return [];
      const pipe = await getPipe();
      const out = await pipe(clean, { pooling: 'mean', normalize: true });
      const hidden = out.dims[out.dims.length - 1] ?? 0;
      if (hidden === 0) throw new Error('embedder devolvio vectores vacios');
      const rows: number[][] = [];
      for (let i = 0; i < clean.length; i++) {
        rows.push(Array.from({ length: hidden }, (_, j) => out.data[i * hidden + j] ?? 0));
      }
      return rows;
    },
  };
}

/**
 * Embedder activado por entorno: sin PA_SEMANTIC_RECALL=1 devuelve undefined y
 * el recall queda exactamente como estaba (lexico puro).
 */
export function semanticFromEnv(modelsDir: string, env = process.env): Embedder | undefined {
  return env.PA_SEMANTIC_RECALL === '1' ? createLocalEmbedder(modelsDir) : undefined;
}
