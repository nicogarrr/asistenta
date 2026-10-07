/**
 * Capa A del vigilante de precios: barrido de listados de categoría.
 * Lee tarjetas (título, URL, precio actual) de páginas de listado, las compara con la referencia
 * (historia propia o mediana de otras tiendas, la misma que usa la capa B) y propone candidatos.
 * La capa A NUNCA avisa: los candidatos pasan a la ficha (runOnce) donde aplica todo el pipeline
 * (consenso, stock, referencia, relectura >= 30 s, dedupe, alerta).
 */

import {
  detect,
  hostOf,
  isBlockedPage,
  isStoreId,
  MIN_GAP_MS,
  type PriceStore,
  parseEuroCents,
  parseMachinePrice,
  referenceFor,
  STORES,
  type StoreId,
  toUrl,
} from './pricewatch.js';

export interface Card {
  title: string;
  url: string;
  cents: number;
}

export interface Listing {
  store: StoreId;
  category: string;
  url: string;
  pages: number;
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

const EXCLUDED =
  /\b(funda|fundas|carcasa|protector|cable|cables|soporte|cargador|repuesto|recambio|reacondicionad[oa]s?|renewed|segunda mano|outlet|filtro|filtros|bolsa|bolsas|accesorio|accesorios|adaptador|bateria|correa|mochila|maletin|cristal templado|tarjeta regalo|pack de|lote|kit de|capsulas?|descalcificador|detergente|mando (para|de|a distancia)|pegatina|skin)\b/;

export function isExcluded(title: string): boolean {
  return EXCLUDED.test(norm(title));
}

/** Gama alta de tablets: solo estas fichas se vigilan en los listados de la categoría `tablets`. */
const PREMIUM_TABLET =
  /\b(ipad (pro|air)|galaxy tab s(8|9|1\d)|surface pro|xiaomi pad [67]|oneplus pad|matepad (pro|11\.5)|yoga tab (13|pro)|legion tab|lenovo tab p1[23]|pixel tablet)\b/;
/** Accesorios y variantes de gama media que comparten nombre con los modelos de gama alta. */
const NOT_A_TABLET =
  /\b(teclado|keyboard|lapiz|pencil|cubierta|cover|folio|combo touch|funda|case|lite|fe)\b/;

export function isPremiumTablet(title: string): boolean {
  const t = norm(title);
  return PREMIUM_TABLET.test(t) && !NOT_A_TABLET.test(t);
}

const UNIT = /^\d+(gb|tb|hz|w|kg|mah|mp|l|cm|mm|pulgadas|k|bar|rpm|db|mhz|ghz|v)$/;

/** Código de modelo (p. ej. TU65M73HAUXXC) para emparejar el mismo producto entre tiendas. */
export function modelKey(title: string): string | null {
  const lower = norm(title);
  // Solo reconstruye la familia Samsung TUxx-MxxH... documentada por
  // nuestros casos. Otros separadores quedan por URL, no por sufijo comun.
  if (/\btu\d{2}(?:\s*\/\s*|\s+)m\d{2}h[a-z0-9]+\b/.test(lower)) return null;
  if (/\ba\d{2}[-‐‑]android\d+\b/.test(lower)) return null;
  const normalized = lower.replace(/\b(tu\d{2})[-‐‑](m\d{2}h[a-z0-9]{3,9})\b/g, '$1$2');
  const tokens = normalized.split(/[^a-z0-9]+/);
  let best: string | null = null;
  for (const t of tokens) {
    if (t.length < 6 || t.length > 18) continue;
    if (!/[a-z]/.test(t) || (t.match(/\d/g) ?? []).length < 2) continue;
    if (UNIT.test(t)) continue;
    if (best === null || t.length > best.length) best = t;
  }
  return best === null ? null : `m:${best}`;
}

type Json = Record<string, unknown>;

function collect(v: unknown, out: Json[]): void {
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out);
  } else if (v !== null && typeof v === 'object') {
    out.push(v as Json);
    for (const x of Object.values(v as Json)) collect(x, out);
  }
}

function typeIs(n: Json, t: string): boolean {
  const ty = n['@type'];
  return ty === t || (Array.isArray(ty) && ty.includes(t));
}

function offerCents(offers: unknown): number | null {
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    if (o === null || typeof o !== 'object') continue;
    const n = o as Json;
    const cur = n.priceCurrency;
    if (typeof cur === 'string' && cur.toUpperCase() !== 'EUR') continue;
    const single = Number(n.offerCount) === 1;
    const p = parseMachinePrice(n.price ?? (single ? n.lowPrice : undefined));
    if (p !== null) return p;
  }
  return null;
}

function absoluteUrl(store: StoreId, raw: string, base: string): string | null {
  try {
    return toUrl(store, new URL(raw, base).toString());
  } catch {
    return null;
  }
}

function ldCards(store: StoreId, html: string, base: string): Card[] {
  const out: Card[] = [];
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
    collect(data, nodes);
    for (const n of nodes) {
      if (!typeIs(n, 'Product')) continue;
      if (typeof n.name !== 'string' || typeof n.url !== 'string') continue;
      const cents = offerCents(n.offers);
      const url = absoluteUrl(store, n.url, base);
      if (cents === null || cents <= 0 || !url) continue;
      out.push({ title: n.name, url, cents });
    }
  }
  return out;
}

function microdataCards(store: StoreId, html: string, base: string): Card[] {
  const out: Card[] = [];
  const parts = html.split(/itemtype=["']https?:\/\/schema\.org\/Product["']/i).slice(1);
  for (const raw of parts) {
    const chunk = raw.slice(0, 4000);
    const name = /itemprop=["']name["'][^>]*?(?:content=["']([^"']+)["']|>([^<]+)<)/i.exec(chunk);
    const price = /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i.exec(chunk);
    const url = /itemprop=["']url["'][^>]*(?:href|content)=["']([^"']+)["']/i.exec(chunk);
    const title = (name?.[1] ?? name?.[2] ?? '').trim();
    const cents = parseMachinePrice(price?.[1]);
    const abs = url?.[1] ? absoluteUrl(store, url[1], base) : null;
    if (title && cents !== null && cents > 0 && abs) out.push({ title, url: abs, cents });
  }
  return out;
}

function amazonCards(html: string): Card[] {
  const out: Card[] = [];
  const re = /<div[^>]*data-component-type=["']s-search-result["'][^>]*>/gi;
  const starts: { i: number; tag: string }[] = [];
  for (const m of html.matchAll(re)) starts.push({ i: m.index ?? 0, tag: m[0] });
  starts.forEach((s, k) => {
    const chunk = html.slice(s.i, starts[k + 1]?.i ?? s.i + 20000);
    const asin = /data-asin=["']([A-Z0-9]{10})["']/.exec(s.tag)?.[1];
    if (!asin || /AdHolder|s-sponsored|puis-sponsored/i.test(chunk)) return;
    const price = /class=["']a-price["'][^>]*>\s*<span class=["']a-offscreen["']>([^<]+)</i.exec(
      chunk,
    );
    const title = /<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i.exec(chunk)?.[1]?.trim();
    const cents = price?.[1] ? parseEuroCents(price[1].replace(/\u00a0/g, ' ').trim()) : null;
    if (title && cents !== null && cents > 0)
      out.push({ title, url: `https://www.amazon.es/dp/${asin}`, cents });
  });
  return out;
}

export function extractCards(store: StoreId, html: string, base: string): Card[] {
  const found =
    store === 'amazon'
      ? amazonCards(html)
      : (() => {
          const ld = ldCards(store, html, base);
          return ld.length > 0 ? ld : microdataCards(store, html, base);
        })();
  const seen = new Set<string>();
  return found.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

export const DEFAULT_LISTINGS: Listing[] = [
  ['tablets', 'mediamarkt', 'https://www.mediamarkt.es/es/category/tablets-169.html', 4],
  ['tablets', 'mediamarkt', 'https://www.mediamarkt.es/es/category/tablets-android-171.html', 2],
  ['tablets', 'amazon', 'https://www.amazon.es/s?k=ipad+pro+galaxy+tab+s', 2],
  ['tablets', 'pccomponentes', 'https://www.pccomponentes.com/tablets', 2],
  ['televisores', 'mediamarkt', 'https://www.mediamarkt.es/es/category/televisores-399.html', 3],
  ['móviles', 'mediamarkt', 'https://www.mediamarkt.es/es/category/smartphones-263.html', 3],
  ['portátiles', 'mediamarkt', 'https://www.mediamarkt.es/es/category/port%C3%A1tiles-153.html', 3],
  ['lavadoras', 'mediamarkt', 'https://www.mediamarkt.es/es/category/lavadoras-671.html', 3],
  [
    'frigoríficos',
    'mediamarkt',
    'https://www.mediamarkt.es/es/category/frigor%C3%ADficos-combinados-555.html',
    3,
  ],
  [
    'cafeteras',
    'mediamarkt',
    'https://www.mediamarkt.es/es/category/cafeteras-superautom%C3%A1ticas-574.html',
    2,
  ],
  ['consolas', 'mediamarkt', 'https://www.mediamarkt.es/es/category/consolas-843.html', 2],
  ['televisores', 'amazon', 'https://www.amazon.es/televisores/s?k=televisores', 2],
  [
    'móviles',
    'amazon',
    'https://www.amazon.es/telefonos-moviles-libres/s?k=telefonos+moviles+libres',
    2,
  ],
  ['portátiles', 'amazon', 'https://www.amazon.es/s?k=port%C3%A1tiles', 2],
  ['lavadoras', 'amazon', 'https://www.amazon.es/s?k=lavadoras', 2],
  ['frigoríficos', 'amazon', 'https://www.amazon.es/s?k=frigor%C3%ADficos', 2],
  ['cafeteras', 'amazon', 'https://www.amazon.es/s?k=cafetera+superautom%C3%A1tica', 2],
  ['consolas', 'amazon', 'https://www.amazon.es/s?k=consola', 2],
  ['televisores', 'pccomponentes', 'https://www.pccomponentes.com/televisores/smart-tv', 2],
  ['móviles', 'pccomponentes', 'https://www.pccomponentes.com/smartphone-y-tablets', 2],
  ['portátiles', 'pccomponentes', 'https://www.pccomponentes.com/portatiles', 2],
  ['lavadoras', 'pccomponentes', 'https://www.pccomponentes.com/lavadoras', 2],
  ['frigoríficos', 'pccomponentes', 'https://www.pccomponentes.com/frigorificos', 2],
  ['cafeteras', 'pccomponentes', 'https://www.pccomponentes.com/cafeteras-superautomaticas', 2],
  ['consolas', 'pccomponentes', 'https://www.pccomponentes.com/videoconsolas-ps5', 2],
  ['televisores', 'carrefour', 'https://www.carrefour.es/tv-sonido/televisores-tv/cat4154555/c', 2],
  ['móviles', 'carrefour', 'https://www.carrefour.es/moviles-foto/smartphones/cat32745043/c', 2],
  ['portátiles', 'carrefour', 'https://www.carrefour.es/informatica/portatiles/cat410364/c', 2],
  [
    'lavadoras',
    'carrefour',
    'https://www.carrefour.es/electrodomesticos/lavadoras/cat4165460/c',
    2,
  ],
  [
    'frigoríficos',
    'carrefour',
    'https://www.carrefour.es/electrodomesticos/frigorificos-congeladores/frigorificos/cat4164135/c',
    2,
  ],
  [
    'cafeteras',
    'carrefour',
    'https://www.carrefour.es/electrodomesticos/preparacion-alimentos/cafeteras-hervidores/cafeteras-expreso-superautomaticas/cat4164735/c',
    2,
  ],
  ['consolas', 'carrefour', 'https://www.carrefour.es/gaming/consolas/cat6420004/c', 2],
  ['televisores', 'elcorteingles', 'https://www.elcorteingles.es/electronica/tv/', 2],
  [
    'móviles',
    'elcorteingles',
    'https://www.elcorteingles.es/electronica/moviles-y-smartphones/',
    2,
  ],
  [
    'portátiles',
    'elcorteingles',
    'https://www.elcorteingles.es/electronica/ordenadores/portatiles/',
    2,
  ],
  ['lavadoras', 'elcorteingles', 'https://www.elcorteingles.es/electrodomesticos/lavadoras/', 2],
  [
    'frigoríficos',
    'elcorteingles',
    'https://www.elcorteingles.es/electrodomesticos/frigorificos-y-neveras/frigorificos-1-puerta/',
    2,
  ],
  [
    'cafeteras',
    'elcorteingles',
    'https://www.elcorteingles.es/delonghi/electrodomesticos/cafeteras/superautomaticas/',
    2,
  ],
  ['consolas', 'elcorteingles', 'https://www.elcorteingles.es/videojuegos/', 1],
  [
    'frigoríficos',
    'fnac',
    'https://www.fnac.es/n133370/Frigorificos-y-neveras/Frigorificos-bajo-consumo',
    2,
  ],
  ['televisores', 'worten', 'https://www.worten.es/productos/televisores', 2],
  ['móviles', 'worten', 'https://www.worten.es/productos/moviles-smartphones/smartphones', 2],
  ['portátiles', 'worten', 'https://www.worten.es/productos/informatica/portatiles', 2],
  [
    'lavadoras',
    'worten',
    'https://www.worten.es/productos/electrodomesticos/lavado-y-cuidado-de-la-ropa/lavadoras',
    2,
  ],
  [
    'cafeteras',
    'worten',
    'https://www.worten.es/productos/pequenos-electrodomesticos/cafeteras',
    2,
  ],
].map(([category, store, url, pages]) => ({
  category: category as string,
  store: store as StoreId,
  url: url as string,
  pages: pages as number,
}));

/** URL de la página n (n >= 1) de un listado. Solo se paginan las tiendas con patrón verificado. */
export function pageUrl(l: Listing, n: number): string | null {
  if (n <= 1) return l.url;
  try {
    const u = new URL(l.url);
    if (
      l.store === 'mediamarkt' ||
      l.store === 'amazon' ||
      l.store === 'pccomponentes' ||
      l.store === 'worten'
    ) {
      u.searchParams.set('page', String(n));
      return u.toString();
    }
    if (l.store === 'elcorteingles') {
      u.pathname = `${u.pathname.replace(/\/$/, '')}/${n}/`;
      return u.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export interface Candidate {
  key: string;
  store: StoreId;
  url: string;
  title: string;
  cents: number;
  dropPct: number;
}

export interface ScanDeps {
  store: PriceStore;
  listings: Listing[];
  minDropPct: number;
  pagesPerRun: number;
  dailyCap: number;
  maxCandidates: number;
  gapMs: number;
  now: () => number;
  random: () => number;
  fetchPage: (url: string) => Promise<{ status: number; html: string }>;
  robotsAllows: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  notify: (text: string) => Promise<void>;
}

export interface ScanSummary {
  pages: number;
  cards: number;
  candidates: Candidate[];
  failures: number;
  blockedStores: string[];
  noCardStores: string[];
  capped: string[];
}

export const NO_CARDS_BEFORE_OFF = 3;
const RECORD_EVERY_MS = 3 * 3600 * 1000;
/** Un candidato ya enviado a ficha no se vuelve a proponer durante este tiempo. */
export const CANDIDATE_COOLDOWN_MS = 8 * 3600 * 1000;

interface Job {
  store: StoreId;
  listing: Listing;
  page: number;
  url: string;
}

function jobsFor(listings: Listing[]): Map<StoreId, Job[]> {
  const byStore = new Map<StoreId, Job[]>();
  for (const l of listings) {
    for (let p = 1; p <= Math.max(1, l.pages); p++) {
      const url = pageUrl(l, p);
      if (!url || !toUrl(l.store, url)) continue;
      const list = byStore.get(l.store) ?? [];
      list.push({ store: l.store, listing: l, page: p, url });
      byStore.set(l.store, list);
    }
  }
  return byStore;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function scanOnce(d: ScanDeps): Promise<ScanSummary> {
  const out: ScanSummary = {
    pages: 0,
    cards: 0,
    candidates: [],
    failures: 0,
    blockedStores: [],
    noCardStores: [],
    capped: [],
  };
  const gap = Number.isFinite(d.gapMs) ? Math.max(d.gapMs, MIN_GAP_MS) : MIN_GAP_MS;
  const perRun = Math.max(1, Math.floor(d.pagesPerRun));
  const queues: Job[][] = [];
  for (const [store, jobs] of jobsFor(d.listings)) {
    if (d.store.getMeta(`nocards_off:${store}:${dayKey(d.now())}`) > 0) {
      out.noCardStores.push(STORES[store].name);
      continue;
    }
    const host = hostOf(jobs[0]?.url ?? '');
    const used = d.store.getMeta(`reqs:${host}:${dayKey(d.now())}`);
    const room = Math.max(0, Math.floor(d.dailyCap) - used);
    if (room === 0) {
      out.capped.push(STORES[store].name);
      continue;
    }
    const cursor = d.store.getMeta(`scan_cursor:${store}`) % jobs.length;
    const take = Math.min(perRun, room, jobs.length);
    const picked: Job[] = [];
    for (let i = 0; i < take; i++) {
      const j = jobs[(cursor + i) % jobs.length];
      if (j) picked.push(j);
    }
    d.store.setMeta(`scan_cursor:${store}`, (cursor + take) % jobs.length);
    queues.push(picked);
  }
  const jobs: Job[] = [];
  for (let i = 0; queues.some((q) => i < q.length); i++)
    for (const q of queues) {
      const j = q[i];
      if (j) jobs.push(j);
    }

  const lastReq = new Map<string, number>();
  const blocked = new Set<string>();
  const stopped = new Set<StoreId>();
  const cands = new Map<string, Candidate>();

  for (const job of jobs) {
    const host = hostOf(job.url);
    if (blocked.has(host) || stopped.has(job.store)) continue;
    if (d.store.blockedUntil(host) > d.now()) {
      blocked.add(host);
      continue;
    }
    if (!(await d.robotsAllows(job.url))) continue;
    const last = lastReq.get(host);
    if (last !== undefined) {
      const need = gap * (1 + 0.2 * d.random()) - (d.now() - last);
      if (need > 0) await d.sleep(need);
    }
    let page: { status: number; html: string } | null = null;
    try {
      page = await d.fetchPage(job.url);
    } catch {
      page = null;
    }
    lastReq.set(host, d.now());
    const reqKey = `reqs:${host}:${dayKey(d.now())}`;
    d.store.setMeta(reqKey, d.store.getMeta(reqKey) + 1);
    out.pages++;
    if (!page) {
      out.failures++;
      continue;
    }
    if (isBlockedPage(page.status, page.html)) {
      d.store.block(host);
      blocked.add(host);
      continue;
    }
    d.store.clearBlock(host);
    const cards = page.status === 200 ? extractCards(job.store, page.html, job.url) : [];
    if (cards.length === 0) {
      out.failures++;
      const n = d.store.getMeta(`nocards:${job.store}`) + 1;
      d.store.setMeta(`nocards:${job.store}`, n);
      if (n >= NO_CARDS_BEFORE_OFF) {
        stopped.add(job.store);
        out.noCardStores.push(STORES[job.store].name);
        d.store.setMeta(`nocards_off:${job.store}:${dayKey(d.now())}`, 1);
        if (d.store.getMeta(`nocards_notified:${job.store}`) === 0) {
          d.store.setMeta(`nocards_notified:${job.store}`, 1);
          await d.notify(
            `Barrido de precios: ${STORES[job.store].name} no devuelve productos legibles en sus listados (render JS o cambio de página). Se pausa hoy en esa tienda.`,
          );
        }
      }
      continue;
    }
    d.store.setMeta(`nocards:${job.store}`, 0);
    for (const c of cards) {
      if (isExcluded(c.title)) continue;
      if (job.listing.category === 'tablets' && !isPremiumTablet(c.title)) continue;
      out.cards++;
      const key = modelKey(c.title) ?? `u:${job.store}:${new URL(c.url).pathname}`;
      const ref = referenceFor(
        d.store.history(key, job.store),
        d.now(),
        d.store.latestOthers(key, job.store),
      );
      const sus = detect(c.cents, ref, d.minDropPct);
      if (sus) {
        const id = `${key}|${job.store}`;
        const prev = cands.get(id);
        if (!prev || c.cents < prev.cents)
          cands.set(id, {
            key,
            store: job.store,
            url: c.url,
            title: c.title,
            cents: c.cents,
            dropPct: sus.dropPct,
          });
        continue;
      }
      if (d.now() - d.store.lastTs(key, job.store) >= RECORD_EVERY_MS)
        d.store.record(key, job.store, c.cents);
    }
  }
  out.blockedStores = [...blocked];
  out.candidates = [...cands.values()]
    .filter((c) => d.now() - d.store.getMeta(`cand:${c.key}|${c.store}`) >= CANDIDATE_COOLDOWN_MS)
    .sort((a, b) => b.dropPct - a.dropPct)
    .slice(0, Math.max(0, d.maxCandidates));
  for (const c of out.candidates) d.store.setMeta(`cand:${c.key}|${c.store}`, d.now());
  return out;
}

export interface ScanConfig {
  enabled: boolean;
  pagesPerRun: number;
  dailyRequestsPerStore: number;
  maxCandidates: number;
  listings: Listing[];
}

function intIn(v: unknown, name: string, def: number, lo: number, hi: number): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
    throw new Error(`scan.${name} debe ser un entero entre ${lo} y ${hi}`);
  return v;
}

export function parseScanConfig(raw: unknown): ScanConfig {
  const root = (raw ?? {}) as Json;
  const s = root.scan === undefined ? {} : (root.scan as Json);
  if (s === null || typeof s !== 'object' || Array.isArray(s))
    throw new Error('scan debe ser un objeto');
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean')
    throw new Error('scan.enabled debe ser true o false');
  if (s.focus !== undefined && typeof s.focus !== 'string')
    throw new Error('scan.focus debe ser el nombre de una categoría');
  let listings = DEFAULT_LISTINGS;
  if (s.listings !== undefined) {
    if (!Array.isArray(s.listings)) throw new Error('scan.listings debe ser una lista');
    listings = s.listings.map((x, i) => {
      const l = x as Json;
      if (typeof l.store !== 'string' || !isStoreId(l.store))
        throw new Error(`scan.listings[${i}].store desconocida`);
      if (typeof l.url !== 'string' || !toUrl(l.store, l.url))
        throw new Error(`scan.listings[${i}].url no válida para ${l.store}`);
      return {
        store: l.store,
        category: typeof l.category === 'string' ? l.category : '',
        url: l.url,
        pages: intIn(l.pages, `listings[${i}].pages`, 1, 1, 5),
      };
    });
  }
  if (s.focus !== undefined) {
    const focus = s.focus;
    listings = listings.filter((l) => l.category === focus);
    if (listings.length === 0)
      throw new Error(`scan.focus: no hay listados de la categoría ${focus}`);
  }
  return {
    enabled: s.enabled === true,
    pagesPerRun: intIn(s.pagesPerRun, 'pagesPerRun', 5, 1, 20),
    dailyRequestsPerStore: intIn(s.dailyRequestsPerStore, 'dailyRequestsPerStore', 170, 10, 400),
    maxCandidates: intIn(s.maxCandidates, 'maxCandidates', 10, 1, 30),
    listings,
  };
}
