/**
 * F15: buscar skills en un índice JSON que Nico configura (PA_SKILLS_INDEX_URL).
 *
 * Solo devuelve nombre + URL (+ descripción corta). Instalar sigue por
 * `/skills instalar <url>`, con la validación estricta de import.ts; aquí no
 * se descarga ni se instala nada.
 *
 * Formatos aceptados: `[{ name, url, description? }]` o `{ skills: [...] }`.
 */
import { foldAccents } from '../text.js';

export const SKILL_INDEX_MAX_BYTES = 1024 * 1024;
export const SKILL_INDEX_TIMEOUT_MS = 15_000;
export const SKILL_SEARCH_LIMIT = 10;

export interface SkillIndexEntry {
  name: string;
  url: string;
  description: string;
}

const clean = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value
        // biome-ignore lint/suspicious/noControlCharactersInRegex: quitar controles del texto ajeno
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Entradas válidas del índice: nombre no vacío y URL https sin credenciales. */
export function parseSkillIndex(data: unknown): SkillIndexEntry[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { skills?: unknown }).skills)
      ? (data as { skills: unknown[] }).skills
      : null;
  if (!list) throw new Error('el índice no es una lista de skills');
  const out: SkillIndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = clean(rec.name, 80);
    const url = httpsUrl(rec.url);
    if (!name || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({ name, url, description: clean(rec.description, 160) });
    if (out.length >= 5_000) break;
  }
  return out;
}

const words = (text: string): string[] =>
  foldAccents(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Todas las palabras de la búsqueda tienen que aparecer (sin tildes ni
 * mayúsculas) en el nombre o la descripción. Primero las que casan en el nombre.
 */
export function searchSkillIndex(
  entries: SkillIndexEntry[],
  query: string,
  limit = SKILL_SEARCH_LIMIT,
): SkillIndexEntry[] {
  const terms = words(query);
  if (!terms.length) return [];
  const scored: Array<{ entry: SkillIndexEntry; score: number; i: number }> = [];
  entries.forEach((entry, i) => {
    const name = foldAccents(entry.name.toLowerCase());
    const all = `${name} ${foldAccents(entry.description.toLowerCase())}`;
    if (!terms.every((t) => all.includes(t))) return;
    const score = terms.filter((t) => name.includes(t)).length;
    scored.push({ entry, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, Math.max(0, Math.min(limit, SKILL_SEARCH_LIMIT))).map((s) => s.entry);
}

export interface FetchSkillIndexOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Descarga el índice (solo https, con plazo y tamaño máximo) y lo valida. */
export async function fetchSkillIndex(
  indexUrl: string,
  opts: FetchSkillIndexOptions = {},
): Promise<SkillIndexEntry[]> {
  const url = httpsUrl(indexUrl);
  if (!url) throw new Error('PA_SKILLS_INDEX_URL tiene que ser una URL https');
  const maxBytes = opts.maxBytes ?? SKILL_INDEX_MAX_BYTES;
  const response = await (opts.fetchImpl ?? fetch)(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? SKILL_INDEX_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`el índice ha respondido ${response.status}`);
  if (response.url && !response.url.startsWith('https:')) {
    throw new Error('el índice ha redirigido fuera de https');
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('el índice es demasiado grande');
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error('el índice es demasiado grande');
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new Error('el índice no es JSON válido');
  }
  return parseSkillIndex(data);
}

/** Texto de respuesta de `/skills buscar`. */
export function formatSkillSearch(query: string, hits: SkillIndexEntry[]): string {
  if (!hits.length) return `No hay skills en el índice que casen con «${query}».`;
  return [
    `Skills que casan con «${query}» (${hits.length}):`,
    ...hits.map(
      (h, n) => `${n + 1}. ${h.name}${h.description ? ` — ${h.description}` : ''}\n   ${h.url}`,
    ),
    'Para instalar una: /skills instalar <url> (se revisa antes de guardarla).',
  ].join('\n');
}
