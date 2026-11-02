/**
 * Lista de apps de la tele guardada (por tele), para no pedirla en cada orden.
 *
 * Antes cada «abre RTVE Play» o «abre Movistar Plus+» (un nombre que no es un
 * alias exacto) pedía `listLaunchPoints` a la tele: una respuesta de decenas
 * de KB (iconos incluidos) antes de poder lanzar nada, y lo mismo en cada
 * action=apps. Ahora la lista se guarda en memoria y en el kv del store
 * (sobrevive a un reinicio) y se reutiliza durante `ttlMs`.
 *
 * Nunca se queda vieja en silencio: quien la usa puede pedir `fresh` (una app
 * que no aparece en la guardada se vuelve a buscar en la tele) e
 * `invalidate` (un lanzamiento fallido tira la lista de esa tele).
 */

export interface TvApp {
  id: string;
  title: string;
}

export interface TvAppCacheStore {
  kvGet(key: string): string | null | undefined;
  kvSet(key: string, value: string): void;
}

export interface TvAppCacheOptions {
  store?: TvAppCacheStore;
  /** Cuánto vale una lista guardada (por defecto 12 h: instalar apps es raro). */
  ttlMs?: number;
  now?: () => number;
}

export const TV_APPS_TTL_MS = 12 * 60 * 60_000;
const KV_PREFIX = 'tv:apps:';

interface Saved {
  at: number;
  apps: TvApp[];
}

function parseSaved(raw: string | null | undefined): Saved | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    const s = p as { at?: unknown; apps?: unknown };
    if (typeof s.at !== 'number' || !Array.isArray(s.apps)) return null;
    const apps = s.apps.filter(
      (a): a is TvApp =>
        !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.title === 'string',
    );
    return { at: s.at, apps };
  } catch {
    return null;
  }
}

export interface TvAppCache {
  /** La lista de esa tele: la guardada si vale, si no la pide (y la guarda). */
  get(host: string, fetch: () => Promise<TvApp[]>, opts?: { fresh?: boolean }): Promise<TvApp[]>;
  /** Tira la lista guardada de esa tele (p. ej. tras un lanzamiento fallido). */
  invalidate(host: string): void;
}

export function createTvAppCache(opts: TvAppCacheOptions): TvAppCache {
  const ttl = opts.ttlMs ?? TV_APPS_TTL_MS;
  const now = opts.now ?? Date.now;
  const mem = new Map<string, Saved>();
  const inflight = new Map<string, Promise<TvApp[]>>();
  const valid = (s: Saved | null | undefined): s is Saved =>
    !!s && now() >= s.at && now() - s.at < ttl;

  const load = (host: string, fetch: () => Promise<TvApp[]>): Promise<TvApp[]> => {
    const running = inflight.get(host);
    if (running) return running;
    const p = fetch()
      .then((apps) => {
        const list = apps.map((a) => ({ id: a.id, title: a.title }));
        const saved = { at: now(), apps: list };
        mem.set(host, saved);
        try {
          opts.store?.kvSet(KV_PREFIX + host, JSON.stringify(saved));
        } catch {
          // Guardarla es un extra: si el kv falla, la lista de memoria sirve igual.
        }
        return list;
      })
      .finally(() => inflight.delete(host));
    inflight.set(host, p);
    return p;
  };

  return {
    async get(host, fetch, o) {
      if (!o?.fresh) {
        const m = mem.get(host);
        if (valid(m)) return m.apps;
        let saved: Saved | null = null;
        try {
          saved = parseSaved(opts.store?.kvGet(KV_PREFIX + host));
        } catch {
          saved = null;
        }
        if (valid(saved)) {
          mem.set(host, saved);
          return saved.apps;
        }
      }
      return load(host, fetch);
    },
    invalidate(host) {
      mem.delete(host);
      try {
        opts.store?.kvSet(KV_PREFIX + host, '');
      } catch {
        // nada que tirar
      }
    },
  };
}
