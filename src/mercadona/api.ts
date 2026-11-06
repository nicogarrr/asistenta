/**
 * Mercadona compra online (tienda.mercadona.es): la API que usa su propia web.
 *
 * No hay API pública para pedir. Lo que hay es la API JSON que la web llama desde el
 * navegador (`/api/customers/<uuid>/cart/`, `/checkouts/`, `/slots/`…), autenticada con
 * el token que la web guarda en `localStorage["MO-user"]` al iniciar sesión. Por eso las
 * llamadas con sesión se hacen DENTRO de la pestaña de tienda.mercadona.es del Chrome del
 * dueño (`browserTransport`): su sesión, sus cookies, su almacén; el token nunca sale de
 * la página ni pasa por el modelo.
 *
 * La búsqueda de productos es pública (Algolia, con la clave de solo búsqueda que la web
 * lleva en su código) y va directa desde Node.
 *
 * Rutas y formas sacadas del bundle de la web (v10100, 5 nov 2026); los tests usan
 * respuestas grabadas o con esa forma, nunca la web real.
 */

export const MERCADONA_ORIGIN = 'https://tienda.mercadona.es';
const ALGOLIA_APP = '7UZJKL1DJ0';
const ALGOLIA_SEARCH_KEY = '9d8f2e39e90df472b4f2e559a116fe17';

export type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Respuesta {
  status: number;
  body: unknown;
}

/** Sesión de la web en el navegador del dueño. */
export interface Sesion {
  /** uuid del cliente; null = no ha iniciado sesión en la web. */
  uuid: string | null;
  /** Almacén (lo fija el código postal): «mad1», «vlc1»… */
  warehouse: string | null;
  postalCode: string | null;
}

/** Cómo se habla con la web. En producción, la pestaña del navegador; en tests, un falso. */
export interface Transporte {
  sesion(): Promise<Sesion>;
  /** `path` sin `/api` (p. ej. `/customers/<uuid>/cart/`). */
  llamar(metodo: Metodo, path: string, body?: unknown): Promise<Respuesta>;
}

/** Lo mínimo del navegador que hace falta (BrowserService lo cumple). */
export interface NavegadorMercadona {
  execJs(scope: string, code: string): Promise<{ text: string }>;
}

const MARCA = '@@MERCA@@';

/** El código que corre en la pestaña: lee la sesión y llama a /api con el token de la web. */
export function codigoPestana(
  op: { tipo: 'sesion' } | { tipo: 'llamar'; metodo: Metodo; path: string; body?: unknown },
): string {
  const arg = JSON.stringify(op);
  return [
    `if (!page.url().startsWith(${JSON.stringify(MERCADONA_ORIGIN)})) {`,
    `  await page.goto(${JSON.stringify(`${MERCADONA_ORIGIN}/`)}, { waitUntil: 'domcontentloaded' });`,
    '  await page.waitForTimeout(1500);',
    '}',
    'const r = await page.evaluate(async (a) => {',
    "  let u = null; try { u = JSON.parse(localStorage.getItem('MO-user') || 'null'); } catch {}",
    "  let da = {}; const ck = document.cookie.split('; ').find((c) => c.startsWith('__mo_da='));",
    '  if (ck) { try { da = JSON.parse(decodeURIComponent(ck.slice(8))); } catch {} }',
    "  if (a.tipo === 'sesion') return { uuid: (u && u.token && u.uuid) || null, warehouse: da.warehouse || null, postalCode: da.postalCode || null };",
    "  const sep = a.path.includes('?') ? '&' : '?';",
    "  const url = '/api' + a.path + sep + 'lang=es' + (da.warehouse ? '&wh=' + encodeURIComponent(da.warehouse) : '');",
    "  const headers = { 'content-type': 'application/json' };",
    "  if (u && u.token) headers.authorization = 'Bearer ' + u.token;",
    "  const res = await fetch(url, { method: a.metodo, headers, credentials: 'include', body: a.body === undefined ? undefined : JSON.stringify(a.body) });",
    '  const t = await res.text(); let body = null;',
    '  try { body = t ? JSON.parse(t) : null; } catch { body = t.slice(0, 300); }',
    '  return { status: res.status, body };',
    `}, ${arg});`,
    `return ${JSON.stringify(MARCA)} + JSON.stringify(r) + ${JSON.stringify(MARCA)};`,
  ].join('\n');
}

/** Saca el JSON marcado de la salida de execJs; un error de la página se lanza tal cual. */
export function leerSalida(text: string): unknown {
  const i = text.indexOf(MARCA);
  const j = text.lastIndexOf(MARCA);
  if (i < 0 || j <= i) {
    throw new Error(`la pestaña de Mercadona no respondió bien: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(i + MARCA.length, j));
}

/**
 * Transporte por la pestaña del Chrome del dueño. Un 401 recarga la web una vez (la web
 * renueva su token al arrancar) y repite.
 */
export function browserTransport(browser: NavegadorMercadona, scope: string): Transporte {
  const run = async (op: Parameters<typeof codigoPestana>[0]): Promise<unknown> =>
    leerSalida((await browser.execJs(scope, codigoPestana(op))).text);
  return {
    sesion: async () => (await run({ tipo: 'sesion' })) as Sesion,
    llamar: async (metodo, path, body) => {
      const op = { tipo: 'llamar' as const, metodo, path, body };
      let r = (await run(op)) as Respuesta;
      if (r.status === 401) {
        await browser.execJs(
          scope,
          `await page.goto(${JSON.stringify(`${MERCADONA_ORIGIN}/`)}, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); return 'ok';`,
        );
        r = (await run(op)) as Respuesta;
      }
      return r;
    },
  };
}

/** Un producto tal y como lo devuelven la búsqueda y la API (solo lo que usamos). */
export interface ProductoApi {
  id: string;
  display_name: string;
  packaging?: string | null;
  published?: boolean;
  share_url?: string;
  price_instructions?: {
    unit_price?: string | null;
    bulk_price?: string | null;
    reference_format?: string | null;
    size_format?: string | null;
    unit_size?: number | null;
    total_units?: number | null;
    selling_method?: number | null;
  };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Búsqueda pública de productos en el almacén del dueño (Algolia de la web). */
export async function buscarProductos(
  consulta: string,
  warehouse: string,
  fetchImpl: Fetch = fetch,
  max = 12,
): Promise<ProductoApi[]> {
  const wh = /^[a-z]{2,4}\d{1,2}$/i.test(warehouse) ? warehouse.toLowerCase() : 'vlc1';
  const res = await fetchImpl(
    `https://${ALGOLIA_APP}-dsn.algolia.net/1/indexes/products_prod_${wh}_es/query`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-algolia-application-id': ALGOLIA_APP,
        'x-algolia-api-key': ALGOLIA_SEARCH_KEY,
      },
      body: JSON.stringify({ query: consulta, hitsPerPage: max }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`la búsqueda de Mercadona respondió ${res.status}`);
  const data = (await res.json()) as { hits?: ProductoApi[] };
  return (data.hits ?? []).filter((h) => h && typeof h.id === 'string' && h.published !== false);
}
