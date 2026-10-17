import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Enrutador web propio (idea tomada de treg, hecha en casa, sin depender de
 * terceros): varios backends GRATIS para buscar y leer la web, fallback
 * automatico entre ellos, tope de coste €0 y medicion por peticion.
 *
 * Reglas duras (plan aprobado por Nico, 16-oct-2026):
 *
 * 1. Tope €0 fail-closed. Un backend declara su coste por llamada; el router
 *    solo llama a los que esten por debajo del tope (por defecto 0). Un coste
 *    invalido (NaN, negativo, infinito) cuenta como "por encima del tope":
 *    nunca se llama. Si no queda ningun backend, falla en claro; NUNCA cobra.
 * 2. Fallback automatico: si un backend falla (red, 429, 5xx, contenido
 *    vacio), se intenta el siguiente y se registra el intento.
 * 3. Medicion: cada intento deja una linea JSONL con latencia, exito, chars,
 *    tokens estimados y coste. Sin URLs completas ni claves: solo el host.
 */

export type WebOp = 'search' | 'fetch';

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
}

export interface WebSearchResult {
  items: WebSearchItem[];
  /** Caracteres de contenido util devuelto (para medir calidad/coste). */
  chars: number;
}

export interface WebFetchResult {
  text: string;
  chars: number;
  status?: number;
}

export interface WebBackend {
  id: string;
  ops: readonly WebOp[];
  /** Coste declarado por llamada en EUR. 0 = gratis. */
  costPerCallEur: number;
  search?(query: string, opts: { maxResults: number }): Promise<WebSearchResult>;
  fetch?(url: string, opts: { maxChars: number }): Promise<WebFetchResult>;
}

export interface WebMetric {
  ts: string;
  op: WebOp;
  backend: string;
  ok: boolean;
  latencyMs: number;
  chars: number;
  /** Estimacion tokens ~= chars/4 (regla comun para texto ES/EN). */
  estTokens: number;
  costEur: number;
  host?: string;
  /** Clase de error (sin mensaje: un mensaje puede arrastrar datos de la peticion). */
  error?: string;
}

export interface RouteSuccess<T> {
  via: string;
  result: T;
  attempts: Array<{ backend: string; ok: boolean; latencyMs: number; error?: string }>;
}

/** Coste declarado valido: finito, >= 0. Cualquier otra cosa cierra el paso. */
function declaredCostOk(cost: number): boolean {
  return Number.isFinite(cost) && cost >= 0;
}

export interface WebRouterOptions {
  backends: WebBackend[];
  /** Tope de coste por llamada en EUR. Por defecto 0: solo gratis. */
  maxCostEur?: number;
  /** JSONL de metricas; undefined = no persiste (tests). */
  metricsPath?: string;
}

export class WebRouter {
  private readonly opts: WebRouterOptions;

  constructor(opts: WebRouterOptions) {
    this.opts = opts;
  }

  private get maxCostEur(): number {
    return this.opts.maxCostEur ?? 0;
  }

  /** Backends que pueden hacer la operacion Y caben en el tope, en orden. */
  eligible(op: WebOp): WebBackend[] {
    return this.opts.backends.filter(
      (b) =>
        b.ops.includes(op) &&
        declaredCostOk(b.costPerCallEur) &&
        b.costPerCallEur <= this.maxCostEur,
    );
  }

  private async record(m: WebMetric): Promise<void> {
    const path = this.opts.metricsPath;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(m)}\n`, 'utf8');
    } catch {
      // La metrica nunca rompe la peticion: peor caso, se pierde una linea.
    }
  }

  async routeSearch(
    query: string,
    opts: { maxResults?: number; host?: string } = {},
  ): Promise<RouteSuccess<WebSearchResult>> {
    const candidates = this.eligible('search').filter((b) => b.search);
    if (candidates.length === 0) {
      throw new Error(
        'No hay ningun backend de busqueda gratuito disponible. Configura una clave gratuita (por ejemplo web:tinyfishApiKey en el vault) o intentalo mas tarde. Nunca se cobra nada: tope €0.',
      );
    }
    const attempts: RouteSuccess<WebSearchResult>['attempts'] = [];
    for (const backend of candidates) {
      const started = Date.now();
      try {
        const search = backend.search?.bind(backend);
        if (!search) continue;
        const result = await search(query, { maxResults: opts.maxResults ?? 8 });
        if (result.items.length === 0) {
          throw new Error('0 resultados');
        }
        const latencyMs = Date.now() - started;
        attempts.push({ backend: backend.id, ok: true, latencyMs });
        await this.record({
          ts: new Date().toISOString(),
          op: 'search',
          backend: backend.id,
          ok: true,
          latencyMs,
          chars: result.chars,
          estTokens: Math.ceil(result.chars / 4),
          costEur: backend.costPerCallEur,
          host: opts.host,
        });
        return { via: backend.id, result, attempts };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const error = err instanceof Error ? err.name : 'Error';
        attempts.push({ backend: backend.id, ok: false, latencyMs, error });
        await this.record({
          ts: new Date().toISOString(),
          op: 'search',
          backend: backend.id,
          ok: false,
          latencyMs,
          chars: 0,
          estTokens: 0,
          costEur: backend.costPerCallEur,
          host: opts.host,
          error,
        });
      }
    }
    throw new Error(
      `Todos los backends gratuitos de busqueda fallaron: ${attempts
        .map((a) => `${a.backend} (${a.error ?? 'error'})`)
        .join(', ')}. No se ha cobrado nada: tope €0.`,
    );
  }

  async routeFetch(
    url: string,
    opts: { maxChars?: number; host?: string } = {},
  ): Promise<RouteSuccess<WebFetchResult>> {
    const candidates = this.eligible('fetch').filter((b) => b.fetch);
    if (candidates.length === 0) {
      throw new Error(
        'No hay ningun backend de lectura web gratuito disponible. Nunca se cobra nada: tope €0.',
      );
    }
    const attempts: RouteSuccess<WebFetchResult>['attempts'] = [];
    for (const backend of candidates) {
      const started = Date.now();
      try {
        const fetchFn = backend.fetch?.bind(backend);
        if (!fetchFn) continue;
        const result = await fetchFn(url, { maxChars: opts.maxChars ?? 20_000 });
        if (result.chars === 0) {
          throw new Error('contenido vacio');
        }
        const latencyMs = Date.now() - started;
        attempts.push({ backend: backend.id, ok: true, latencyMs });
        await this.record({
          ts: new Date().toISOString(),
          op: 'fetch',
          backend: backend.id,
          ok: true,
          latencyMs,
          chars: result.chars,
          estTokens: Math.ceil(result.chars / 4),
          costEur: backend.costPerCallEur,
          host: opts.host,
        });
        return { via: backend.id, result, attempts };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const error = err instanceof Error ? err.name : 'Error';
        attempts.push({ backend: backend.id, ok: false, latencyMs, error });
        await this.record({
          ts: new Date().toISOString(),
          op: 'fetch',
          backend: backend.id,
          ok: false,
          latencyMs,
          chars: 0,
          estTokens: 0,
          costEur: backend.costPerCallEur,
          host: opts.host,
          error,
        });
      }
    }
    throw new Error(
      `Todos los backends gratuitos de lectura web fallaron: ${attempts
        .map((a) => `${a.backend} (${a.error ?? 'error'})`)
        .join(', ')}. No se ha cobrado nada: tope €0.`,
    );
  }
}

export interface BackendStats {
  backend: string;
  op: WebOp;
  calls: number;
  ok: number;
  okPct: number;
  p50Ms: number;
  p95Ms: number;
  totalChars: number;
  totalEstTokens: number;
  totalCostEur: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

/** Agrega el JSONL de metricas por backend y operacion. Lineas rotas se ignoran. */
export function aggregateMetrics(metrics: WebMetric[]): BackendStats[] {
  const groups = new Map<string, WebMetric[]>();
  for (const m of metrics) {
    const key = `${m.op}::${m.backend}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const out: BackendStats[] = [];
  for (const [key, list] of [...groups.entries()].sort()) {
    const lat = list.map((m) => m.latencyMs).sort((a, b) => a - b);
    const ok = list.filter((m) => m.ok).length;
    const sep = key.indexOf('::');
    out.push({
      backend: key.slice(sep + 2),
      op: key.slice(0, sep) as WebOp,
      calls: list.length,
      ok,
      okPct: Math.round((ok / list.length) * 1000) / 10,
      p50Ms: percentile(lat, 50),
      p95Ms: percentile(lat, 95),
      totalChars: list.reduce((s, m) => s + m.chars, 0),
      totalEstTokens: list.reduce((s, m) => s + m.estTokens, 0),
      totalCostEur: list.reduce((s, m) => s + m.costEur, 0),
    });
  }
  return out;
}

/** Lee el JSONL de metricas; archivo ausente = sin metricas todavia. */
export async function readMetrics(path: string): Promise<WebMetric[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: WebMetric[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as WebMetric;
      if (parsed && typeof parsed.backend === 'string' && typeof parsed.op === 'string') {
        out.push(parsed);
      }
    } catch {
      // Linea corrupta: se salta.
    }
  }
  return out;
}
