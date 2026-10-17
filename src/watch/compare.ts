/**
 * /compara <url>: el mismo producto en las 7 tiendas del vigilante, a petición del usuario.
 *
 * Decisiones, y por qué:
 * - Nace de una ficha concreta: la identidad del producto sale de SU página (JSON-LD):
 *   EAN/GTIN si lo publica, código de modelo si lo tiene el título (modelKey, el mismo
 *   que usa el barrido) y, como mínimo, el título. No se busca por categorías.
 * - El emparejamiento declara su fuerza: "ean" (verificado en la ficha de la otra
 *   tienda), "modelo" (mismo código de modelo en el título) o "titulo" (título muy
 *   parecido, se presenta como probable). Si la ficha candidata publica un EAN
 *   distinto, NO es el mismo producto: esa tienda queda "no encontrada".
 * - El precio mostrado es SIEMPRE el de la ficha leída con el extractor de consenso
 *   (nunca el de la tarjeta del buscador): fuentes que discrepan = "no fiable";
 *   captcha, bloqueo o ausencia de precio = "no se pudo comprobar". El precio tachado
 *   no se usa.
 * - Es una acción manual y puntual: 1 petición de búsqueda + 1 ficha por tienda
 *   (máx. 13 peticiones), con una pausa de cortesía entre ellas. El barrido automático
 *   sigue teniendo sus propios límites (robots, presupuesto diario, backoff), que
 *   aquí no aplican porque no hay bucle.
 * - Este módulo no hace red: `fetchHtml` y `sleep` se inyectan (en producción, el
 *   mismo camino con control SSRF que la tool fetch).
 */

import { type Card, extractCards, modelKey } from './listscan.js';
import { eur } from './pages.js';
import {
  type Extraction,
  extractReading,
  hostOf,
  isBlockedPage,
  STORES,
  type StoreId,
} from './pricewatch.js';

export interface ProductIdentity {
  title: string;
  ean: string | null;
  model: string | null;
}

export type MatchKind = 'ean' | 'modelo' | 'titulo';

export interface CompareRow {
  store: StoreId;
  status: 'ok' | 'no-encontrado' | 'no-fiable' | 'error';
  cents: number | null;
  inStock: boolean | null;
  url: string;
  match: MatchKind | null;
  /** Razón corta cuando no hay precio ("captcha o bloqueo", "sin ficha clara"...). */
  note: string;
}

export interface CompareReport {
  seed: { url: string; store: StoreId; identity: ProductIdentity };
  rows: CompareRow[];
  /** Fila ok con el precio más bajo, si la hay. */
  best: CompareRow | null;
  at: number;
}

/** Búsqueda nativa de cada tienda. Si una cambia, esa tienda falla en claro y las demás siguen. */
export function searchUrl(store: StoreId, query: string): string {
  const q = encodeURIComponent(query);
  switch (store) {
    case 'amazon':
      return `https://www.amazon.es/s?k=${q}`;
    case 'mediamarkt':
      return `https://www.mediamarkt.es/es/search.html?query=${q}`;
    case 'pccomponentes':
      return `https://www.pccomponentes.com/search/?query=${q}`;
    case 'carrefour':
      return `https://www.carrefour.es/global/search?query=${q}`;
    case 'elcorteingles':
      return `https://www.elcorteingles.es/search/?s=${q}`;
    case 'fnac':
      return `https://www.fnac.es/SearchResult/ResultList.aspx?Search=${q}`;
    case 'worten':
      return `https://www.worten.es/search?query=${q}`;
  }
}

type Json = Record<string, unknown>;

function walk(v: unknown, out: Json[]): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, out);
  } else if (v !== null && typeof v === 'object') {
    const o = v as Json;
    out.push(o);
    for (const x of Object.values(o)) walk(x, out);
  }
}

function eanOf(n: Json): string | null {
  for (const key of ['gtin13', 'gtin8', 'gtin', 'ean']) {
    const v = n[key];
    const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    if (/^\d{8,14}$/.test(s)) return s;
  }
  return null;
}

/** Identidad del producto desde el HTML de su ficha: EAN si lo publica, modelo y título. */
export function productIdentity(html: string): ProductIdentity {
  let title = '';
  let ean: string | null = null;
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(m[1] ?? '');
    } catch {
      continue;
    }
    const nodes: Json[] = [];
    walk(data, nodes);
    for (const n of nodes) {
      const t = n['@type'];
      if (t !== 'Product' && !(Array.isArray(t) && t.includes('Product'))) continue;
      if (!title && typeof n.name === 'string') title = n.name.trim();
      ean ??= eanOf(n);
      if (title && ean) break;
    }
    if (title && ean) break;
  }
  if (!title) {
    const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
    const tag = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    title = (og?.[1] ?? tag?.[1] ?? '').trim();
  }
  return { title, ean, model: title ? modelKey(title) : null };
}

function normTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

const STOP = new Set(['para', 'con', 'sin', 'los', 'las', 'una', 'del', 'nuevo', 'nueva']);

/** Solape de tokens significativos semilla -> título de la tarjeta (0-1). */
export function titleOverlap(seedTitle: string, cardTitle: string): number {
  const seed = normTokens(seedTitle).filter((t) => !STOP.has(t));
  const card = new Set(normTokens(cardTitle));
  if (seed.length === 0) return 0;
  const hit = seed.filter((t) => card.has(t)).length;
  return hit / seed.length;
}

/** La mejor tarjeta que puede ser el mismo producto, declarando cómo se sabe. */
export function pickMatch(
  cards: Card[],
  identity: ProductIdentity,
): { card: Card; match: MatchKind } | null {
  if (identity.model) {
    const byModel = cards.find((c) => modelKey(c.title) === identity.model);
    if (byModel) return { card: byModel, match: 'modelo' };
  }
  let best: { card: Card; score: number } | null = null;
  for (const c of cards) {
    const score = titleOverlap(identity.title, c.title);
    if (!best || score > best.score) best = { card: c, score };
  }
  if (best && best.score >= 0.7) return { card: best.card, match: 'titulo' };
  return null;
}

/** El EAN que publica la propia ficha candidata, si lo publica. */
function fichaEan(html: string): string | null {
  return productIdentity(html).ean;
}

export interface CompareDeps {
  fetchHtml: (url: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Pausa de cortesía entre peticiones de una comparación manual. */
export const COMPARE_GAP_MS = 1_000;

function rowFromFicha(
  store: StoreId,
  url: string,
  match: MatchKind | null,
  html: string,
): CompareRow {
  const base = { store, url, match };
  if (isBlockedPage(200, html)) {
    return { ...base, status: 'error', cents: null, inStock: null, note: 'captcha o bloqueo' };
  }
  const ext: Extraction = extractReading(store, html);
  if (ext.cents === null) {
    return {
      ...base,
      status: 'error',
      cents: null,
      inStock: ext.inStock,
      note: 'sin precio claro',
    };
  }
  if (!ext.reliable) {
    return {
      ...base,
      status: 'no-fiable',
      cents: null,
      inStock: ext.inStock,
      note: 'las fuentes de la página no coinciden',
    };
  }
  return { ...base, status: 'ok', cents: ext.cents, inStock: ext.inStock, note: '' };
}

/**
 * Compara el producto de `seedUrl` en las 7 tiendas. Nunca lanza por una tienda:
 * un fallo deja esa fila en "error" y el resto sigue. Lanza solo si la semilla
 * no es una tienda conocida o no tiene identidad aprovechable.
 */
export async function compareProduct(seedUrl: string, d: CompareDeps): Promise<CompareReport> {
  const seedStore = (Object.keys(STORES) as StoreId[]).find((id) =>
    STORES[id].hosts.some((h) => {
      const host = hostOf(seedUrl);
      return host === h || host === `www.${h}` || host.endsWith(`.${h}`);
    }),
  );
  if (!seedStore) throw new Error('ese enlace no es de una tienda que conozco');
  const now = d.now ?? Date.now;
  const rows: CompareRow[] = [];
  let seedHtml: string;
  try {
    seedHtml = await d.fetchHtml(seedUrl);
  } catch (err) {
    throw new Error(
      `no pude leer la ficha que me pasas (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const identity = productIdentity(seedHtml);
  if (!identity.title && !identity.ean) {
    throw new Error('no saco qué producto es esa ficha; pásame el enlace del producto');
  }
  rows.push(rowFromFicha(seedStore, seedUrl, null, seedHtml));
  const query = identity.ean ?? identity.model ?? normTokens(identity.title).slice(0, 6).join(' ');
  for (const store of (Object.keys(STORES) as StoreId[]).filter((s) => s !== seedStore)) {
    await d.sleep(COMPARE_GAP_MS);
    const fail = (note: string): CompareRow => ({
      store,
      status: 'error',
      cents: null,
      inStock: null,
      url: '',
      match: null,
      note,
    });
    let cards: Card[];
    try {
      const searchHtml = await d.fetchHtml(searchUrl(store, query));
      if (isBlockedPage(200, searchHtml)) {
        rows.push(fail('captcha o bloqueo en la búsqueda'));
        continue;
      }
      cards = extractCards(store, searchHtml, searchUrl(store, query));
    } catch (err) {
      rows.push(fail(err instanceof Error ? err.message : String(err)));
      continue;
    }
    const picked = pickMatch(cards, identity);
    if (!picked) {
      rows.push({
        store,
        status: 'no-encontrado',
        cents: null,
        inStock: null,
        url: '',
        match: null,
        note: 'no aparece en su buscador',
      });
      continue;
    }
    await d.sleep(COMPARE_GAP_MS);
    let ficha: string;
    try {
      ficha = await d.fetchHtml(picked.card.url);
    } catch (err) {
      rows.push(fail(err instanceof Error ? err.message : String(err)));
      continue;
    }
    if (identity.ean) {
      const other = fichaEan(ficha);
      if (other !== null && other !== identity.ean) {
        rows.push({
          store,
          status: 'no-encontrado',
          cents: null,
          inStock: null,
          url: picked.card.url,
          match: null,
          note: 'el candidato tiene otro EAN: no es el mismo producto',
        });
        continue;
      }
    }
    const match: MatchKind =
      identity.ean && fichaEan(ficha) === identity.ean ? 'ean' : picked.match;
    rows.push(rowFromFicha(store, picked.card.url, match, ficha));
  }
  const ok = rows.filter((r) => r.status === 'ok' && r.cents !== null);
  const best = ok.reduce<CompareRow | null>(
    (acc, r) => (acc === null || (r.cents ?? 0) < (acc.cents ?? 0) ? r : acc),
    null,
  );
  return { seed: { url: seedUrl, store: seedStore, identity }, rows, best, at: now() };
}

const MATCH_LABEL: Record<MatchKind, string> = {
  ean: 'mismo EAN',
  modelo: 'mismo modelo',
  titulo: 'título muy parecido (probable)',
};

/** Tabla en español para Telegram; cada fila declara precio, stock y cómo se emparejó. */
export function describeCompare(r: CompareReport): string {
  const fmtTime = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
  });
  const name = r.seed.identity.title || r.seed.url;
  const lines = [`${name}`, `Comparado a las ${fmtTime.format(r.at)} (hora de Madrid):`];
  const sorted = [...r.rows].sort((a, b) => {
    if (a.status === 'ok' && b.status === 'ok') return (a.cents ?? 0) - (b.cents ?? 0);
    if (a.status === 'ok') return -1;
    if (b.status === 'ok') return 1;
    return 0;
  });
  for (const row of sorted) {
    const store = STORES[row.store].name;
    if (row.status === 'ok') {
      const stock =
        row.inStock === true
          ? 'en stock'
          : row.inStock === false
            ? 'consta agotado'
            : 'stock sin confirmar';
      const match = row.match ? ` · ${MATCH_LABEL[row.match]}` : ' · tu enlace';
      const best = r.best === row ? ' · MEJOR PRECIO' : '';
      lines.push(`- ${store}: ${eur(row.cents ?? 0)} (${stock}${match})${best}`);
      if (row.url && row.url !== r.seed.url) lines.push(`  ${row.url}`);
    } else if (row.status === 'no-encontrado') {
      lines.push(`- ${store}: no lo encuentro (${row.note})`);
    } else if (row.status === 'no-fiable') {
      lines.push(`- ${store}: precio no fiable (${row.note}); ${row.url}`);
    } else {
      lines.push(`- ${store}: no se pudo comprobar (${row.note})`);
    }
  }
  return lines.join('\n');
}
