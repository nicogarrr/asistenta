/**
 * Vigilante de errores de precio en tiendas españolas (Amazon.es, MediaMarkt, PcComponentes,
 * Carrefour, El Corte Inglés, Fnac, Worten). Sin coste: HTTP normal desde el PC del usuario.
 *
 * Decisiones, y por qué:
 * - Este módulo no hace red ni envía nada: `fetchPage`, `sleep`, `notify` y `random` se inyectan.
 *   Así se prueba sin tocar ninguna tienda y el token de Telegram nunca pasa por aquí.
 * - Extracción multi-estrategia con consenso: JSON-LD (schema.org Product/Offer), metaetiquetas
 *   y microdatos, y como último recurso el selector propio de la tienda (Amazon). Si dos fuentes
 *   de la misma ficha discrepan más de un 2 %, la lectura es "no fiable" y no puede avisar:
 *   un precio mal leído es el falso error más común.
 * - Cadencia conservadora: >= 30 s entre páginas del MISMO dominio (el mínimo se fuerza en código,
 *   la config solo puede subirlo; se añade jitter hacia arriba). Ante captcha/403/429/503 se
 *   bloquea ESA tienda con esperas crecientes (1 min, 5, 30, 2 h); las demás siguen.
 * - Se respeta robots.txt de cada dominio: una ruta Disallow no se lee.
 * - Una lectura sin precio legible NO es un precio: es fallo, nunca 0.
 * - Referencia del precio normal: mediana propia (>= 5 lecturas previas en >= 3 días) y, si no
 *   hay historia, mediana de las OTRAS tiendas para el mismo producto (>= 2, de las últimas 24 h).
 *   El precio tachado de la ficha NO se usa: las tiendas lo inflan.
 * - Solo avisa con stock confirmado o desconocido (nunca con "agotado": suele ser precio fantasma),
 *   tras releer la página >= 30 s después y ver el mismo precio bajo. Etiqueta "posible error de
 *   precio": es una sospecha, no un hecho. No compra nada.
 */

import type { DatabaseSync } from 'node:sqlite';
import { localDay } from '../datecontext.js';

export const MIN_GAP_MS = 30_000;
export const MIN_READINGS = 5;
export const MIN_SPAN_MS = 3 * 24 * 3600 * 1000;
export const WINDOW_MS = 30 * 24 * 3600 * 1000;
export const CROSS_WINDOW_MS = 24 * 3600 * 1000;
export const MIN_CROSS_STORES = 2;
export const DEFAULT_MIN_DROP_PCT = 70;
export const BACKOFF_MINUTES = [1, 5, 30, 120];
export const REALERT_MS = 24 * 3600 * 1000;
export const EMPTY_RUNS_BEFORE_NOTICE = 3;
export const SOURCE_TOLERANCE = 0.02;
export const CONFIRM_TOLERANCE = 0.05;

export type StoreId =
  | 'amazon'
  | 'mediamarkt'
  | 'pccomponentes'
  | 'carrefour'
  | 'elcorteingles'
  | 'fnac'
  | 'worten';

export const STORES: Record<StoreId, { name: string; hosts: string[] }> = {
  amazon: { name: 'Amazon.es', hosts: ['amazon.es'] },
  mediamarkt: { name: 'MediaMarkt', hosts: ['mediamarkt.es'] },
  pccomponentes: { name: 'PcComponentes', hosts: ['pccomponentes.com'] },
  carrefour: { name: 'Carrefour', hosts: ['carrefour.es'] },
  elcorteingles: { name: 'El Corte Inglés', hosts: ['elcorteingles.es'] },
  fnac: { name: 'Fnac', hosts: ['fnac.es'] },
  worten: { name: 'Worten', hosts: ['worten.es'] },
};

const ASIN = /^[A-Z0-9]{10}$/;

export function isAsin(s: string): boolean {
  return ASIN.test(s);
}

export function isStoreId(s: string): s is StoreId {
  return Object.hasOwn(STORES, s);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostBelongs(host: string, store: StoreId): boolean {
  return STORES[store].hosts.some(
    (h) => host === h || host === `www.${h}` || host.endsWith(`.${h}`),
  );
}

/** Referencia de la config -> URL de producto, o null si no es válida para esa tienda. */
export function toUrl(store: StoreId, ref: string): string | null {
  if (store === 'amazon' && isAsin(ref)) return `https://www.amazon.es/dp/${ref}`;
  try {
    const u = new URL(ref);
    if (u.protocol !== 'https:' || !hostBelongs(u.hostname.toLowerCase(), store)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** "1.299,50 €" / "12,34€" -> céntimos. Formato español estricto; otro formato da null. */
export function parseEuroCents(raw: string): number | null {
  const m = raw.match(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s?€/);
  if (!m?.[1]) return null;
  const euros = Number(m[1].replace(/\./g, ''));
  const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return euros * 100 + cents;
}

/** Número de schema.org/metaetiquetas ("1299.99", 1299.99 o "1.299,00") -> céntimos. */
export function parseMachinePrice(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+(\.\d{1,2})?$/.test(s)) return Math.round(Number(s) * 100) || null;
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(s)) return parseEuroCents(`${s} €`);
  return null;
}

export type SourceKind = 'jsonld' | 'meta' | 'selector';

export interface Extraction {
  cents: number | null;
  inStock: boolean | null;
  /** false = dos fuentes discrepan: no puede disparar alerta. */
  reliable: boolean;
  sources: { kind: SourceKind; cents: number }[];
}

function walk(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    out.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, out);
  }
}

function typeIncludes(o: Record<string, unknown>, name: string): boolean {
  const t = o['@type'];
  return t === name || (Array.isArray(t) && t.includes(name));
}

function stockFromAvailability(a: unknown): boolean | null {
  if (typeof a !== 'string') return null;
  if (/OutOfStock|SoldOut|Discontinued|PreOrder|BackOrder|PreSale/i.test(a)) return false;
  if (/InStock|LimitedAvailability|OnlineOnly|InStoreOnly/i.test(a)) return true;
  return null;
}

function jsonLd(html: string): { cents: number | null; inStock: boolean | null } {
  let cents: number | null = null;
  let inStock: boolean | null = null;
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(m[1] ?? '');
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    walk(data, nodes);
    for (const n of nodes) {
      if (!typeIncludes(n, 'Offer') && !typeIncludes(n, 'AggregateOffer')) continue;
      const cur = n.priceCurrency;
      if (typeof cur === 'string' && cur.toUpperCase() !== 'EUR') continue;
      // lowPrice de un AggregateOffer puede mezclar vendedores externos: solo si hay una única oferta.
      const single = Number(n.offerCount) === 1;
      const p = parseMachinePrice(n.price ?? (single ? n.lowPrice : undefined));
      if (p === null) continue;
      if (cents === null) {
        cents = p;
        inStock = stockFromAvailability(n.availability);
      }
    }
    if (cents !== null) break;
  }
  return { cents, inStock };
}

function metaPrice(html: string): number | null {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:product:price:amount|og:price:amount)["']/i,
    /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*itemprop=["']price["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const p = m?.[1] ? parseMachinePrice(m[1]) : null;
    if (p !== null) return p;
  }
  return null;
}

const AMAZON_BLOCK =
  /id="(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)"/;

/** Precio del bloque principal de Amazon (no recomendados): primer `a-offscreen` dentro de él. */
export function amazonSelectorCents(html: string): number | null {
  const at = html.search(AMAZON_BLOCK);
  if (at < 0) return null;
  const m = html.slice(at, at + 4000).match(/class="a-offscreen"[^>]*>\s*([^<]+?)\s*</);
  return m?.[1] ? parseEuroCents(m[1]) : null;
}

function amazonStock(html: string): boolean | null {
  const m = html.match(/id="availability"[\s\S]{0,600}/);
  if (!m) return null;
  if (/no disponible|agotado/i.test(m[0])) return false;
  if (/en stock|disponible|quedan/i.test(m[0])) return true;
  return null;
}

export function extractReading(store: StoreId, html: string): Extraction {
  const sources: Extraction['sources'] = [];
  const ld = jsonLd(html);
  if (ld.cents !== null) sources.push({ kind: 'jsonld', cents: ld.cents });
  const meta = metaPrice(html);
  if (meta !== null) sources.push({ kind: 'meta', cents: meta });
  let inStock = ld.inStock;
  if (store === 'amazon') {
    const sel = amazonSelectorCents(html);
    if (sel !== null) sources.push({ kind: 'selector', cents: sel });
    inStock = inStock ?? amazonStock(html);
  }
  const first = sources[0];
  if (!first) return { cents: null, inStock, reliable: true, sources };
  const reliable = sources.every(
    (s) => Math.abs(s.cents - first.cents) <= first.cents * SOURCE_TOLERANCE,
  );
  return { cents: first.cents, inStock, reliable, sources };
}

export function isBlockedPage(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /validateCaptcha|Introduce los caracteres|Enter the characters you see|api-services-support@amazon|cf-chl-|Just a moment\.\.\.|px-captcha|triggerInterstitialChallenge|bm-verify|akamai.*challenge|captcha-delivery\.com|geo\.captcha-delivery|Incapsula incident/i.test(
    html,
  );
}

/** ¿robots.txt (grupo `*`) prohíbe esta ruta? Prefijos Disallow simples; Allow más largo gana. */
export function robotsDisallows(robotsTxt: string, path: string): boolean {
  let inStar = false;
  let best: { len: number; allow: boolean } | null = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') inStar = val === '*';
    else if (inStar && (key === 'disallow' || key === 'allow') && val) {
      const prefix = val.replace(/\*.*$/, '').replace(/\$$/, '');
      if (prefix && path.startsWith(prefix) && (!best || prefix.length > best.len)) {
        best = { len: prefix.length, allow: key === 'allow' };
      }
    }
  }
  return best !== null && !best.allow;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

export interface Reading {
  ts: number;
  cents: number;
}

export interface Reference {
  cents: number;
  kind: 'propia' | 'cruzada';
  detail: string;
}

export function referenceFor(
  own: Reading[],
  now: number,
  others: { store: StoreId; cents: number }[],
): Reference | null {
  const recent = own.filter((r) => now - r.ts <= WINDOW_MS);
  if (recent.length >= MIN_READINGS) {
    const span = Math.max(...recent.map((r) => r.ts)) - Math.min(...recent.map((r) => r.ts));
    if (span >= MIN_SPAN_MS) {
      return {
        cents: median(recent.map((r) => r.cents)),
        kind: 'propia',
        detail: `mediana de ${recent.length} lecturas en ${Math.floor(span / 86_400_000)} días`,
      };
    }
  }
  if (others.length >= MIN_CROSS_STORES) {
    return {
      cents: median(others.map((o) => o.cents)),
      kind: 'cruzada',
      detail: `mediana de ${others.map((o) => STORES[o.store].name).join(', ')}`,
    };
  }
  return null;
}

export interface Suspicion {
  cents: number;
  ref: Reference;
  dropPct: number;
}

export function detect(cents: number, ref: Reference | null, minDropPct: number): Suspicion | null {
  if (!ref || ref.cents <= 0) return null;
  if (cents > ref.cents * (1 - minDropPct / 100)) return null;
  return { cents, ref, dropPct: Math.round((1 - cents / ref.cents) * 100) };
}

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

export function alertText(
  name: string,
  store: StoreId,
  url: string,
  s: Suspicion,
  inStock: boolean | null,
  at: Date,
): string {
  const when = at.toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return [
    `Posible error de precio (sospecha, sin confirmar): ${name}`,
    `${STORES[store].name}: ${eur(s.cents)} (${s.dropPct} % menos que la referencia).`,
    `${s.ref.kind === 'propia' ? 'Precio habitual observado' : 'Referencia en otras tiendas'}: ${eur(s.ref.cents)}.`,
    `Referencia: ${s.ref.detail} (${s.ref.kind}).`,
    `Stock: ${inStock === true ? 'en stock' : 'sin confirmar'}. Leído ${when}.`,
    url,
  ].join('\n');
}

export class PriceStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_readings (product TEXT NOT NULL, store TEXT NOT NULL, ts INTEGER NOT NULL, cents INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS price_readings_ps_ts ON price_readings (product, store, ts);
      CREATE TABLE IF NOT EXISTS price_alerts (product TEXT NOT NULL, store TEXT NOT NULL, ts INTEGER NOT NULL, cents INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS price_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS price_observations (product TEXT NOT NULL, store TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, cents INTEGER NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, reads INTEGER NOT NULL, PRIMARY KEY (product, store));
      CREATE TABLE IF NOT EXISTS discovered_terms (term TEXT PRIMARY KEY, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL);
    `);
  }

  history(product: string, store: StoreId): Reading[] {
    return this.db
      .prepare(
        'SELECT ts, cents FROM price_readings WHERE product = ? AND store = ? AND ts >= ? ORDER BY ts',
      )
      .all(product, store, this.now() - WINDOW_MS) as unknown as Reading[];
  }

  /** Último precio de cada OTRA tienda para el producto en las últimas 24 h. */
  latestOthers(product: string, store: StoreId): { store: StoreId; cents: number }[] {
    const rows = this.db
      .prepare(
        `SELECT store, cents FROM price_readings r WHERE product = ? AND store <> ? AND ts >= ?
         AND ts = (SELECT MAX(ts) FROM price_readings WHERE product = r.product AND store = r.store)`,
      )
      .all(product, store, this.now() - CROSS_WINDOW_MS) as unknown as {
      store: StoreId;
      cents: number;
    }[];
    return rows;
  }

  record(product: string, store: StoreId, cents: number): void {
    this.db
      .prepare('INSERT INTO price_readings (product, store, ts, cents) VALUES (?, ?, ?, ?)')
      .run(product, store, this.now(), cents);
  }

  alertedRecently(product: string, store: StoreId): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM price_alerts WHERE product = ? AND store = ? AND ts >= ?')
      .get(product, store, this.now() - REALERT_MS) as { n: number };
    return row.n > 0;
  }

  markAlerted(product: string, store: StoreId, cents: number): void {
    this.db
      .prepare('INSERT INTO price_alerts (product, store, ts, cents) VALUES (?, ?, ?, ?)')
      .run(product, store, this.now(), cents);
  }

  /**
   * Observación SIN referencia (producto visto, sin historia propia ni >= 2 otras tiendas).
   * NO es alarma ni entra en la historia de precios: no alimenta referenceFor.
   */
  observe(product: string, store: StoreId, title: string, url: string, cents: number): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO price_observations (product, store, title, url, cents, first_ts, last_ts, reads)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(product, store) DO UPDATE SET title = excluded.title, url = excluded.url,
           cents = excluded.cents, last_ts = excluded.last_ts, reads = reads + 1`,
      )
      .run(product.slice(0, 120), store, title.slice(0, 200), url.slice(0, 500), cents, t, t);
  }

  observationCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM price_observations').get() as { n: number })
      .n;
  }

  /** Conserva solo las `keep` observaciones más recientes. */
  trimObservations(keep: number): void {
    this.db
      .prepare(
        `DELETE FROM price_observations WHERE rowid NOT IN
         (SELECT rowid FROM price_observations ORDER BY last_ts DESC LIMIT ?)`,
      )
      .run(keep);
  }

  discoveredTerms(retentionMs: number): string[] {
    return (
      this.db
        .prepare('SELECT term FROM discovered_terms WHERE last_ts >= ? ORDER BY first_ts, term')
        .all(this.now() - retentionMs) as { term: string }[]
    ).map((r) => r.term);
  }

  /** Alta de término nuevo o renovación de uno ya conocido. */
  touchTerm(term: string): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO discovered_terms (term, first_ts, last_ts) VALUES (?, ?, ?)
         ON CONFLICT(term) DO UPDATE SET last_ts = excluded.last_ts`,
      )
      .run(term, t, t);
  }

  pruneTerms(retentionMs: number): void {
    this.db.prepare('DELETE FROM discovered_terms WHERE last_ts < ?').run(this.now() - retentionMs);
  }

  getMeta(k: string): number {
    return this.get(k);
  }

  setMeta(k: string, v: number): void {
    this.set(k, v);
  }

  /** Marca de tiempo de la última lectura de (producto, tienda); 0 si no hay. */
  lastTs(product: string, store: StoreId): number {
    const row = this.db
      .prepare('SELECT MAX(ts) AS t FROM price_readings WHERE product = ? AND store = ?')
      .get(product, store) as { t: number | null };
    return row.t ?? 0;
  }

  /** Borra lecturas de más de 35 días. */
  prune(): void {
    this.db
      .prepare('DELETE FROM price_readings WHERE ts < ?')
      .run(this.now() - 35 * 24 * 3600 * 1000);
  }

  private get(k: string): number {
    const row = this.db.prepare('SELECT v FROM price_meta WHERE k = ?').get(k) as
      | { v: number }
      | undefined;
    return row?.v ?? 0;
  }

  private set(k: string, v: number): void {
    this.db
      .prepare(
        'INSERT INTO price_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      )
      .run(k, v);
  }

  blockedUntil(host: string): number {
    return this.get(`block_until:${host}`);
  }

  /** Bloquea la tienda con espera creciente: 1 min, 5, 30, 2 h (se queda en 2 h). */
  block(host: string): void {
    const level = this.get(`block_level:${host}`);
    const minutes = BACKOFF_MINUTES[Math.min(level, BACKOFF_MINUTES.length - 1)] ?? 120;
    this.set(`block_until:${host}`, this.now() + minutes * 60_000);
    this.set(`block_level:${host}`, level + 1);
  }

  clearBlock(host: string): void {
    if (this.get(`block_level:${host}`) !== 0) this.set(`block_level:${host}`, 0);
  }

  emptyRuns(): number {
    return this.get('empty_runs');
  }

  setEmptyRuns(n: number): void {
    this.set('empty_runs', n);
  }
}

export interface Product {
  name: string;
  /** Texto para mostrar en la alerta (por defecto, name). */
  label?: string;
  urls: Partial<Record<StoreId, string>>;
}

export interface RunDeps {
  store: PriceStore;
  products: Product[];
  gapMs: number;
  minDropPct: number;
  now: () => number;
  random: () => number;
  managesRequestBudget?: boolean;
  fetchPage: (url: string) => Promise<{ status: number; html: string }>;
  robotsAllows: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  notify: (text: string) => Promise<void>;
  /** Tope diario de peticiones por host (compartido con el barrido); sin valor, sin tope. */
  dailyCap?: number;
}

export interface RunSummary {
  checked: number;
  alerts: number;
  failures: number;
  skipped: number;
  blockedStores: string[];
}

interface Item {
  product: string;
  label: string;
  store: StoreId;
  url: string;
}

/** Items intercalados por tienda para que las esperas de dominio se solapen. */
function buildItems(products: Product[]): Item[] {
  const byStore = new Map<StoreId, Item[]>();
  for (const p of products) {
    for (const [s, ref] of Object.entries(p.urls)) {
      if (!isStoreId(s) || typeof ref !== 'string') continue;
      const url = toUrl(s, ref);
      if (!url) continue;
      const list = byStore.get(s) ?? [];
      list.push({ product: p.name, label: p.label ?? p.name, store: s, url });
      byStore.set(s, list);
    }
  }
  const out: Item[] = [];
  const lists = [...byStore.values()];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const it = l[i];
      if (it) out.push(it);
    }
  }
  return out;
}

export async function runOnce(d: RunDeps): Promise<RunSummary> {
  const out: RunSummary = { checked: 0, alerts: 0, failures: 0, skipped: 0, blockedStores: [] };
  const gap = Number.isFinite(d.gapMs) ? Math.max(d.gapMs, MIN_GAP_MS) : MIN_GAP_MS;
  const lastReq = new Map<string, number>();
  const blocked = new Set<string>();
  const items = buildItems(d.products);

  const overCap = (host: string): boolean =>
    d.dailyCap !== undefined && d.store.getMeta(`reqs:${host}:${localDay(d.now())}`) >= d.dailyCap;

  const throttle = async (host: string): Promise<void> => {
    const last = lastReq.get(host);
    if (last !== undefined) {
      const need = gap * (1 + 0.2 * d.random()) - (d.now() - last);
      if (need > 0) await d.sleep(need);
    }
  };
  const get = async (
    host: string,
    url: string,
  ): Promise<{ status: number; html: string } | null> => {
    await throttle(host);
    if (d.dailyCap !== undefined && !d.managesRequestBudget) {
      const k = `reqs:${host}:${localDay(d.now())}`;
      d.store.setMeta(k, d.store.getMeta(k) + 1);
    }
    try {
      const page = await d.fetchPage(url);
      lastReq.set(host, d.now());
      return page;
    } catch {
      lastReq.set(host, d.now());
      return null;
    }
  };

  for (const it of items) {
    const host = hostOf(it.url);
    if (blocked.has(host)) {
      out.skipped++;
      continue;
    }
    if (d.store.blockedUntil(host) > d.now()) {
      blocked.add(host);
      out.skipped++;
      continue;
    }
    if (!(await d.robotsAllows(it.url))) {
      out.skipped++;
      continue;
    }
    if (overCap(host)) {
      out.skipped++;
      continue;
    }
    const page = await get(host, it.url);
    if (!page) {
      out.failures++;
      continue;
    }
    if (isBlockedPage(page.status, page.html)) {
      d.store.block(host);
      blocked.add(host);
      out.skipped++;
      continue;
    }
    d.store.clearBlock(host);
    const ex = page.status === 200 ? extractReading(it.store, page.html) : null;
    if (!ex || ex.cents === null || ex.cents <= 0 || !ex.reliable) {
      out.failures++;
      continue;
    }
    out.checked++;
    const ref = referenceFor(
      d.store.history(it.product, it.store),
      d.now(),
      d.store.latestOthers(it.product, it.store),
    );
    const suspicion = detect(ex.cents, ref, d.minDropPct);
    if (!suspicion) {
      d.store.record(it.product, it.store, ex.cents);
      continue;
    }
    if (ex.inStock === false || d.store.alertedRecently(it.product, it.store)) continue;
    if (overCap(host)) continue;
    const again = await get(host, it.url);
    if (!again || isBlockedPage(again.status, again.html)) {
      if (again) {
        d.store.block(host);
        blocked.add(host);
      }
      continue;
    }
    const ex2 = again.status === 200 ? extractReading(it.store, again.html) : null;
    if (!ex2 || ex2.cents === null || !ex2.reliable || ex2.inStock === false) continue;
    if (
      Math.abs(ex2.cents - ex.cents) > ex.cents * CONFIRM_TOLERANCE ||
      !detect(ex2.cents, ref, d.minDropPct)
    )
      continue;
    await d.notify(
      alertText(it.label, it.store, it.url, suspicion, ex2.inStock, new Date(d.now())),
    );
    d.store.markAlerted(it.product, it.store, ex2.cents);
    out.alerts++;
  }
  out.blockedStores = [...blocked];
  if (items.length > 0) {
    const empty = out.checked === 0 ? d.store.emptyRuns() + 1 : 0;
    d.store.setEmptyRuns(empty);
    if (empty === EMPTY_RUNS_BEFORE_NOTICE) {
      await d.notify(
        `Vigilante de precios: ${empty} pasadas seguidas sin ninguna lectura de precio. La vigilancia puede estar rota (cambio de página o bloqueo).`,
      );
    }
  }
  return out;
}

export interface WatchConfig {
  enabled: boolean;
  products: Product[];
  gapMs: number;
  minDropPct: number;
  telegram: { enabled: boolean; chatId: string; tokenFile: string; useMainBotFallback: boolean };
}

/** Valida la config tal cual viene del JSON; lanza con un mensaje claro si un tipo no cuadra. */
export function parseConfig(raw: unknown): WatchConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('config: se esperaba un objeto');
  const c = raw as Record<string, unknown>;
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean')
    throw new Error('config: enabled debe ser true/false');
  const gap = c.gapSeconds ?? 30;
  if (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0) {
    throw new Error('config: gapSeconds debe ser un número >= 0');
  }
  const drop = c.minDropPct ?? DEFAULT_MIN_DROP_PCT;
  if (typeof drop !== 'number' || !Number.isFinite(drop) || drop < 10 || drop > 95) {
    throw new Error('config: minDropPct debe ser un número entre 10 y 95');
  }
  const products: Product[] = [];
  const list = c.products ?? [];
  if (!Array.isArray(list)) throw new Error('config: products debe ser una lista');
  for (const p of list) {
    if (typeof p !== 'object' || p === null)
      throw new Error('config: cada producto debe ser un objeto');
    const pr = p as Record<string, unknown>;
    if (typeof pr.name !== 'string' || !pr.name.trim())
      throw new Error('config: cada producto necesita name (texto)');
    if (typeof pr.urls !== 'object' || pr.urls === null || Array.isArray(pr.urls)) {
      throw new Error(`config: ${pr.name}: urls debe ser un objeto tienda -> URL/ASIN`);
    }
    const urls: Partial<Record<StoreId, string>> = {};
    for (const [s, ref] of Object.entries(pr.urls as Record<string, unknown>)) {
      if (!isStoreId(s)) throw new Error(`config: ${pr.name}: tienda desconocida "${s}"`);
      if (typeof ref !== 'string' || toUrl(s, ref) === null) {
        throw new Error(
          `config: ${pr.name}: ${s}: referencia no válida (ASIN o URL https de esa tienda)`,
        );
      }
      urls[s] = ref;
    }
    products.push({ name: pr.name.trim(), urls });
  }
  const t = c.telegram ?? {};
  if (typeof t !== 'object' || t === null || Array.isArray(t))
    throw new Error('config: telegram debe ser un objeto');
  const tg = t as Record<string, unknown>;
  for (const k of ['chatId', 'tokenFile'] as const) {
    if (tg[k] !== undefined && typeof tg[k] !== 'string')
      throw new Error(`config: telegram.${k} debe ser texto`);
  }
  if (tg.useMainBotFallback !== undefined && typeof tg.useMainBotFallback !== 'boolean')
    throw new Error('config: telegram.useMainBotFallback debe ser true/false');
  if (tg.enabled !== undefined && typeof tg.enabled !== 'boolean')
    throw new Error('config: telegram.enabled debe ser true/false');
  return {
    enabled: c.enabled === true,
    products,
    gapMs: gap * 1000,
    minDropPct: drop,
    telegram: {
      enabled: tg.enabled === true,
      useMainBotFallback: tg.useMainBotFallback === true,
      chatId: typeof tg.chatId === 'string' ? tg.chatId : '',
      tokenFile: typeof tg.tokenFile === 'string' ? tg.tokenFile : '',
    },
  };
}
