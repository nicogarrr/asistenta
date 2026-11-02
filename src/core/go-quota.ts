/**
 * Cuota del plan OpenCode Go (rolling / semanal / mensual), leída del propio
 * endpoint del proveedor. Es el único dato que sale de la máquina en el
 * inspector /uso, y solo viaja la clave ya configurada: la respuesta son
 * porcentajes, nunca prompts ni secretos.
 */
import { endpointKind, providerKeyFor } from '../llm-health.js';

export interface GoQuotaWindow {
  status: string;
  percent: number;
  resetsAt?: string;
}

export interface GoQuota {
  rolling?: GoQuotaWindow;
  weekly?: GoQuotaWindow;
  monthly?: GoQuotaWindow;
}

/** Caché corta: /uso no debe martillear el endpoint de cuota. */
export const GO_QUOTA_CACHE_MS = 5 * 60_000;

let cache: { at: number; quota: GoQuota | null } | undefined;

function window_(value: unknown): GoQuotaWindow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const percent =
    typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? raw.percent : null;
  if (percent === null) return undefined;
  return {
    status: typeof raw.status === 'string' ? raw.status : '',
    percent: Math.max(0, Math.round(percent)),
    ...(typeof raw.resetsAt === 'string' ? { resetsAt: raw.resetsAt } : {}),
  };
}

/** Parsea la respuesta de GET {base}/usage; forma desconocida -> null. */
export function parseGoQuota(body: unknown): GoQuota | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const raw = usage as Record<string, unknown>;
  const quota: GoQuota = {
    ...(window_(raw.rolling) ? { rolling: window_(raw.rolling) } : {}),
    ...(window_(raw.weekly) ? { weekly: window_(raw.weekly) } : {}),
    ...(window_(raw.monthly) ? { monthly: window_(raw.monthly) } : {}),
  };
  return quota.rolling || quota.weekly || quota.monthly ? quota : null;
}

export interface GoQuotaDeps {
  /** Resuelve la clave del proveedor (vault/env); mismo enrutado que el chat. */
  getKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  headers?: Record<string, string>;
}

/**
 * Lee la cuota del plan Go. Solo aplica a endpoints OpenCode; con otro
 * proveedor (o sin clave, o con la caché fresca) no hace red. Cualquier fallo
 * devuelve null: /uso funciona igual sin esta sección.
 */
export async function fetchGoQuota(
  baseUrl: string,
  deps: GoQuotaDeps = {},
): Promise<GoQuota | null> {
  if (endpointKind(baseUrl) !== 'opencode') return null;
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < GO_QUOTA_CACHE_MS) return cache.quota;
  const getKey =
    deps.getKey ??
    (async () => {
      // Mismo orden que el chat (env primero en Go): ver providerKeyFor.
      const { vaultGet } = await import('../vault.js');
      return providerKeyFor('opencode', (k) => vaultGet(k).catch(() => undefined), process.env);
    });
  const key = await getKey().catch(() => undefined);
  if (!key) return null;
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/usage`, {
      headers: { Authorization: `Bearer ${key}`, ...(deps.headers ?? {}) },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`usage ${res.status}`);
    const quota = parseGoQuota(await res.json());
    cache = { at: now(), quota };
    return quota;
  } catch {
    cache = { at: now(), quota: null };
    return null;
  }
}

/** Borra la caché (tests y cambio de clave). */
export function resetGoQuotaCache(): void {
  cache = undefined;
}
