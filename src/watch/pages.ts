/**
 * Vigila una página web y avisa cuando cambia el precio (o el texto).
 *
 * Caso de uso real: "avísame si baja el precio de esto" o "dime cuando haya plazas".
 * Hasta ahora Asistenta solo reaccionaba a mensajes; esto le deja mirar por su cuenta.
 *
 * Decisiones, y por qué:
 * - Solo páginas públicas: el texto lo obtiene un `fetchText` inyectado (en producción,
 *   el mismo camino con control SSRF que la tool fetch). Este módulo no hace red.
 * - Una página tiene muchos precios (envío, recomendados, tachados). En páginas sin
 *   tienda conocida se sigue el primer precio en € del texto, y se dice así: es una
 *   heurística, no un contrato. Si la página no tiene ningún precio se vigila el texto
 *   completo (hash).
 * - En fichas de las 7 tiendas del vigilante (Amazon.es, MediaMarkt, PcComponentes,
 *   Carrefour, El Corte Inglés, Fnac, Worten) la lectura es estructurada: el MISMO
 *   extractor con consenso de pricewatch (JSON-LD/meta/selectores). Si las fuentes
 *   discrepan, la página muestra un captcha o no hay precio claro, la lectura es
 *   "no se pudo comprobar": cuenta como fallo, nunca se inventa un número.
 * - Cada lectura fiable se guarda en `watch_readings` (histórico propio, retención de
 *   un año). Eso habilita `/precio` (mín/mediana/máx y evolución) y dos avisos nuevos:
 *   objetivo ("avísame si baja de X €", al cruzar el umbral) y bajada porcentual
 *   ("avísame si baja un Y %", contra la mediana del histórico o la última lectura si
 *   aún hay pocas). El % NUNCA se calcula contra el precio tachado de la tienda.
 * - Un fallo de red o una lectura no fiable NO es un cambio: se cuenta como error y
 *   solo se avisa tras varios seguidos, para no spamear ni ocultar que la vigilancia
 *   está rota.
 * - Un aviso por cambio: tras avisar, el valor nuevo pasa a ser la referencia. Los
 *   avisos por bajada % se repiten como mucho una vez al día salvo mínimo nuevo.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  extractReading,
  hostOf,
  isBlockedPage,
  median,
  parseMachinePrice,
  STORES,
  type StoreId,
} from './pricewatch.js';

export interface PageWatch {
  id: string;
  scope: string;
  url: string;
  label: string;
  /** Último valor visto: "49,90 €" o "texto:<hash>". Vacío = aún sin primera lectura. */
  lastValue: string;
  lastCheckedAt: number;
  failures: number;
  createdAt: number;
  active: boolean;
  /** Si hay palabra, se vigila su presencia en la página en vez del precio. */
  keyword: string;
  /** Aviso al cruzar a la baja este precio (céntimos). null = sin objetivo. */
  targetCents: number | null;
  /** Aviso ante una bajada de al menos este % (1-95). null = sin aviso por bajada. */
  dropPct: number | null;
  /** Último aviso por bajada % (0 = nunca); limita repetición salvo mínimo nuevo. */
  lastAlertAt: number;
  /** Precio del último aviso por bajada %: un mínimo nuevo sí vuelve a avisar. */
  lastAlertCents: number | null;
  /** «🔕 Silenciar»: hasta este instante no se manda ningún aviso de esta página (0 = no). */
  mutedUntil: number;
}

export type CheckOutcome =
  | { kind: 'baseline'; value: string }
  | { kind: 'unchanged'; value: string }
  | {
      kind: 'changed';
      from: string;
      to: string;
      inStock?: boolean | null;
      /** Feed RSS/Atom: entradas que no estaban en la lectura anterior (las más nuevas primero). */
      newItems?: FeedItem[];
    }
  | {
      kind: 'target';
      cents: number;
      targetCents: number;
      inStock: boolean | null;
    }
  | {
      kind: 'drop';
      cents: number;
      referenceCents: number;
      /** De dónde sale la referencia: mediana del histórico o última lectura si hay < 3. */
      referenceKind: 'mediana' | 'ultima';
      dropPct: number;
      inStock: boolean | null;
    }
  | { kind: 'error'; message: string; failures: number; notify: boolean };

// Miles con espacio tipográfico (duro, estrecho o fino: lo que sale de `&nbsp;` o de
// Intl fr-FR) como en el lector de precios compartido (#451): «1 299,00 €» son 1299 €.
// Un número pegado con espacio normal delante («1 299,00 €», «talla 42 199 €») es
// ambiguo: no se lee la cola como si fuera el precio entero (antes daba 299 €).
const THIN = String.raw`\u00a0\u202f\u2009`;
const AMOUNT = String.raw`(?<![\d.,${THIN}])(?<!\d )(\d{1,3}(?:[${THIN}]\d{3})+(?:,\d{1,2})?|\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const PRICE = new RegExp(String.raw`(?:${AMOUNT}\s?(?:€|eur\b)|(?:€|eur\b)\s?${AMOUNT})`, 'i');

/**
 * Number written with "." and/or "," -> [integer digits, cents], or null when the format is
 * ambiguous (the caller then keeps the literal text instead of inventing a value).
 * Both separators: the last one is the decimal mark. One separator repeated: thousands.
 * One separator once: 1-2 digits after it = decimals, exactly 3 = thousands.
 */
export function parseAmount(raw: string): [string, string] | null {
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let intPart = raw;
  let dec = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const pos = Math.max(lastDot, lastComma);
    intPart = raw.slice(0, pos);
    dec = raw.slice(pos + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const pos = raw.lastIndexOf(sep);
    const after = raw.slice(pos + 1);
    const repeated = raw.indexOf(sep) !== pos;
    if (!repeated && sep === ',' && after.length === 3) {
      return null; // "1,459": miles (inglés) o decimales (combustible): ambiguo
    } else if (repeated || after.length === 3) {
      intPart = raw; // thousands only
    } else if (after.length >= 1 && after.length <= 2) {
      intPart = raw.slice(0, pos);
      dec = after;
    } else {
      return null;
    }
  }
  const whole = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole) || (dec !== '' && !/^\d{1,2}$/.test(dec))) return null;
  return [whole, dec.padEnd(2, '0') || '00'];
}

/** Primer precio en euros del texto, normalizado ("1.299,5 EUR" -> "1299,50 EUR"), o null. */
export function extractPrice(text: string): string | null {
  const m = PRICE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? '').replace(/[\u00a0\u202f\u2009]/g, '');
  const parsed = parseAmount(raw);
  // Ambiguous format: keep the digits exactly as the page wrote them rather than a
  // made-up number, in one canonical shape («1,459 €»). The symbol's spelling and
  // position («1,459€», «1,459 EUR», «€ 1,459») is not part of the value: if it
  // were, a cosmetic change on the page would read as a price change.
  if (!parsed) return `${raw} €`;
  return `${parsed[0]},${parsed[1]} €`;
}

/**
 * Whether two stored readings are the same value. Prices are compared in their
 * canonical shape, so a literal saved by an older version («1,459€», «1,459 EUR»)
 * still equals today's «1,459 €» and the first check after an update is not a
 * false «cambio de precio». Keyword and text-hash values compare as they are.
 */
export function sameWatchValue(a: string, b: string): boolean {
  if (a === b) return true;
  const canon = (v: string): string =>
    v.startsWith('texto:') || v.startsWith('feed:') || v === 'presente' || v === 'ausente'
      ? v
      : (extractPrice(v) ?? v);
  return canon(a) === canon(b);
}

const fold = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

export interface FeedItem {
  title: string;
  link: string;
  id: string;
}

/** Cuántas entradas del feed se recuerdan entre lecturas. */
const FEED_ITEMS_KEPT = 30;

const xmlText = (raw: string): string =>
  raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const tagText = (block: string, tag: string): string => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m?.[1] ? xmlText(m[1]) : '';
};

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? '');
  const href = (attrs: string): string => /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
  const alt = links.find((a) => !/\brel\s*=/i.test(a) || /\brel\s*=\s*["']alternate["']/i.test(a));
  return xmlText(href(alt ?? links[0] ?? ''));
}

/** Entradas de un feed RSS/Atom (en el orden del feed), o null si el texto no es un feed. */
export function parseFeedItems(text: string): FeedItem[] | null {
  const head = text.slice(0, 2000);
  const isAtom = /<feed[\s>]/i.test(head);
  if (!isAtom && !/<rss[\s>]|<rdf:RDF[\s>]/i.test(head)) return null;
  const tag = isAtom ? 'entry' : 'item';
  const blocks = [...text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))];
  return blocks.slice(0, FEED_ITEMS_KEPT).map((m) => {
    const b = m[1] ?? '';
    const title = tagText(b, 'title');
    const link = isAtom ? atomLink(b) || tagText(b, 'link') : tagText(b, 'link');
    const id = tagText(b, isAtom ? 'id' : 'guid') || link || title;
    return { title, link, id };
  });
}

const feedKey = (it: FeedItem): string =>
  createHash('sha256').update(it.id).digest('hex').slice(0, 10);

function feedValue(items: FeedItem[]): string {
  return `feed:${items.map(feedKey).join(',')}`;
}

function feedKeys(value: string): Set<string> {
  return new Set(value.slice('feed:'.length).split(',').filter(Boolean));
}

/** Valor que se compara entre lecturas. Con palabra: solo si aparece o no (sin mayúsculas ni tildes). */
export function watchValue(text: string, keyword = ''): string {
  if (keyword) return fold(text).includes(fold(keyword)) ? 'presente' : 'ausente';
  // Un feed nunca se lee como precio: un «19,99 €» en un post daría un «Cambio de precio» falso.
  const feed = parseFeedItems(text);
  if (feed) return feedValue(feed);
  const price = extractPrice(text);
  if (price) return price;
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return `texto:${createHash('sha256').update(norm).digest('hex').slice(0, 16)}`;
}

/** Cuántos fallos seguidos antes de avisar de que la vigilancia no funciona. */
export const FAILURES_BEFORE_NOTICE = 3;
export const MAX_WATCHES_PER_SCOPE = 10;
/** Histórico de lecturas por vigilancia: un año basta para mín/mediana/máx útiles. */
export const READINGS_RETENTION_MS = 366 * 24 * 3600 * 1000;
/** Avisos por bajada %: como mucho uno al día salvo que haya un mínimo nuevo. */
export const REALERT_MS = 24 * 3600 * 1000;
/** Cuánto dura «🔕 Silenciar 1 día». */
export const PAGE_MUTE_MS = 24 * 3600 * 1000;
/** Lecturas que entran en la gráfica de /precio. */
export const SPARKLINE_POINTS = 20;

/** "129950" -> "1.299,50 €". Formato español, sin redondeos: los céntimos ya vienen dados. */
export function eur(cents: number): string {
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  const s = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${s},${rest} €`;
}

/** ¿La URL es ficha de una de las 7 tiendas del vigilante? null = página genérica. */
export function storeForUrl(url: string): StoreId | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const id of Object.keys(STORES) as StoreId[]) {
    const { hosts } = STORES[id];
    if (hosts.some((h) => host === h || host === `www.${h}` || host.endsWith(`.${h}`))) {
      return id;
    }
  }
  return null;
}

function row(r: Record<string, unknown>): PageWatch {
  return {
    id: String(r.id),
    scope: String(r.scope),
    url: String(r.url),
    label: String(r.label ?? ''),
    lastValue: String(r.last_value ?? ''),
    lastCheckedAt: Number(r.last_checked_at ?? 0),
    failures: Number(r.failures ?? 0),
    createdAt: Number(r.created_at ?? 0),
    active: Number(r.active ?? 1) === 1,
    keyword: String(r.keyword ?? ''),
    targetCents: r.target_cents == null ? null : Number(r.target_cents),
    dropPct: r.drop_pct == null ? null : Number(r.drop_pct),
    lastAlertAt: Number(r.last_alert_at ?? 0),
    lastAlertCents: r.last_alert_cents == null ? null : Number(r.last_alert_cents),
    mutedUntil: Number(r.muted_until ?? 0),
  };
}

export interface WatchReading {
  ts: number;
  cents: number;
  inStock: boolean | null;
}

export interface WatchSummary {
  readings: number;
  firstAt: number;
  lastAt: number;
  lastCents: number;
  lastInStock: boolean | null;
  minCents: number;
  medianCents: number;
  maxCents: number;
  sparkline: string;
}

export class PageWatchStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS page_watches (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      last_value TEXT NOT NULL DEFAULT '', last_checked_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    const cols = db.prepare('PRAGMA table_info(page_watches)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'keyword')) {
      db.exec("ALTER TABLE page_watches ADD COLUMN keyword TEXT NOT NULL DEFAULT ''");
    }
    // Objetivos y anti-repetición de avisos: columnas añadidas después; se migran igual.
    if (!cols.some((c) => c.name === 'target_cents')) {
      db.exec('ALTER TABLE page_watches ADD COLUMN target_cents INTEGER');
    }
    if (!cols.some((c) => c.name === 'drop_pct')) {
      db.exec('ALTER TABLE page_watches ADD COLUMN drop_pct REAL');
    }
    if (!cols.some((c) => c.name === 'last_alert_at')) {
      db.exec('ALTER TABLE page_watches ADD COLUMN last_alert_at INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.some((c) => c.name === 'last_alert_cents')) {
      db.exec('ALTER TABLE page_watches ADD COLUMN last_alert_cents INTEGER');
    }
    if (!cols.some((c) => c.name === 'muted_until')) {
      db.exec('ALTER TABLE page_watches ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0');
    }
    // Histórico propio por vigilancia: solo lecturas fiables (consenso del extractor).
    db.exec(`CREATE TABLE IF NOT EXISTS watch_readings (
      watch_id TEXT NOT NULL, ts INTEGER NOT NULL, cents INTEGER NOT NULL, in_stock INTEGER)`);
    db.exec('CREATE INDEX IF NOT EXISTS watch_readings_w_ts ON watch_readings (watch_id, ts)');
  }

  add(
    scope: string,
    url: string,
    label = '',
    keyword = '',
    opts: { targetCents?: number | null; dropPct?: number | null } = {},
  ): PageWatch {
    const kw = keyword.trim().slice(0, 60);
    const existing = this.list(scope).find((w) => w.url === url && w.keyword === kw);
    if (existing) {
      // Misma página + misma palabra = la misma vigilancia. Si el usuario pasa un
      // objetivo nuevo ("/vigila <url> objetivo=400€"), se reconfigura sin duplicar.
      if (opts.targetCents !== undefined || opts.dropPct !== undefined) {
        this.db
          .prepare('UPDATE page_watches SET target_cents = ?, drop_pct = ? WHERE id = ?')
          .run(opts.targetCents ?? null, opts.dropPct ?? null, existing.id);
        return this.get(existing.id) as PageWatch;
      }
      return existing;
    }
    if (this.list(scope).length >= MAX_WATCHES_PER_SCOPE) {
      throw new Error(
        `ya vigilas ${MAX_WATCHES_PER_SCOPE} páginas; quita alguna antes de añadir otra`,
      );
    }
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare(
        'INSERT INTO page_watches (id, scope, url, label, created_at, keyword, target_cents, drop_pct) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        scope,
        url,
        label.slice(0, 80),
        this.now(),
        kw,
        opts.targetCents ?? null,
        opts.dropPct ?? null,
      );
    return this.get(id) as PageWatch;
  }

  get(id: string): PageWatch | null {
    const r = this.db.prepare('SELECT * FROM page_watches WHERE id = ?').get(id);
    return r ? row(r as Record<string, unknown>) : null;
  }

  list(scope: string): PageWatch[] {
    return this.db
      .prepare('SELECT * FROM page_watches WHERE scope = ? AND active = 1 ORDER BY created_at')
      .all(scope)
      .map((r) => row(r as Record<string, unknown>));
  }

  /** Todas las activas de todos los chats (vista única de vigilancias). */
  listAll(): PageWatch[] {
    return this.db
      .prepare('SELECT * FROM page_watches WHERE active = 1 ORDER BY created_at')
      .all()
      .map((r) => row(r as Record<string, unknown>));
  }

  /** Todas las activas, para el planificador. */
  due(everyMs: number): PageWatch[] {
    return this.db
      .prepare('SELECT * FROM page_watches WHERE active = 1 AND last_checked_at <= ?')
      .all(this.now() - everyMs)
      .map((r) => row(r as Record<string, unknown>));
  }

  /**
   * «🔕 Silenciar»: sin avisos de esta página durante `ms` (se sigue leyendo y guardando
   * el histórico). Solo desde el chat dueño; no borra nada. null si no es suya o no existe.
   */
  mute(scope: string, id: string, ms: number): PageWatch | null {
    const w = this.list(scope).find((x) => x.id === id);
    if (!w) return null;
    this.db
      .prepare('UPDATE page_watches SET muted_until = ? WHERE id = ?')
      .run(this.now() + ms, w.id);
    return this.get(w.id);
  }

  /** Quita el silencio antes de tiempo (mismo chat). */
  unmute(scope: string, id: string): PageWatch | null {
    const w = this.list(scope).find((x) => x.id === id);
    if (!w) return null;
    this.db.prepare('UPDATE page_watches SET muted_until = 0 WHERE id = ?').run(w.id);
    return this.get(w.id);
  }

  remove(scope: string, idOrPrefix: string): boolean {
    const w = this.list(scope).find((x) => x.id === idOrPrefix || x.id.startsWith(idOrPrefix));
    if (!w) return false;
    this.db.prepare('UPDATE page_watches SET active = 0 WHERE id = ?').run(w.id);
    return true;
  }

  /** Fallo contado, sin cambiar la referencia: se avisa una vez al llegar al umbral. */
  private fail(w: PageWatch, message: string): CheckOutcome {
    const failures = w.failures + 1;
    this.db
      .prepare('UPDATE page_watches SET failures = ?, last_checked_at = ? WHERE id = ?')
      .run(failures, this.now(), w.id);
    return { kind: 'error', message, failures, notify: failures === FAILURES_BEFORE_NOTICE };
  }

  /** Guarda una lectura fiable y poda el histórico fuera de retención. */
  private recordReading(watchId: string, cents: number, inStock: boolean | null): void {
    const now = this.now();
    this.db
      .prepare('INSERT INTO watch_readings (watch_id, ts, cents, in_stock) VALUES (?,?,?,?)')
      .run(watchId, now, cents, inStock === null ? null : inStock ? 1 : 0);
    this.db.prepare('DELETE FROM watch_readings WHERE ts < ?').run(now - READINGS_RETENTION_MS);
  }

  /** Lecturas fiables dentro de la retención, de más antigua a más reciente. */
  readings(watchId: string): WatchReading[] {
    return this.db
      .prepare(
        'SELECT ts, cents, in_stock FROM watch_readings WHERE watch_id = ? AND ts >= ? ORDER BY ts',
      )
      .all(watchId, this.now() - READINGS_RETENTION_MS)
      .map((r) => {
        const x = r as { ts: number; cents: number; in_stock: number | null };
        return { ts: x.ts, cents: x.cents, inStock: x.in_stock === null ? null : x.in_stock === 1 };
      });
  }

  /** Resumen del histórico para /precio; null si aún no hay lecturas. */
  summary(watchId: string): WatchSummary | null {
    const rs = this.readings(watchId);
    const first = rs[0];
    if (!first) return null;
    const last = rs[rs.length - 1] ?? first;
    const cents = rs.map((r) => r.cents);
    return {
      readings: rs.length,
      firstAt: first.ts,
      lastAt: last.ts,
      lastCents: last.cents,
      lastInStock: last.inStock,
      minCents: Math.min(...cents),
      medianCents: median(cents),
      maxCents: Math.max(...cents),
      sparkline: sparkline(rs.slice(-SPARKLINE_POINTS).map((r) => r.cents)),
    };
  }

  private markAlert(watchId: string, cents: number): void {
    this.db
      .prepare('UPDATE page_watches SET last_alert_at = ?, last_alert_cents = ? WHERE id = ?')
      .run(this.now(), cents, watchId);
  }

  /** Bajada % ya avisada: solo repite si pasó un día o hay un mínimo nuevo. */
  private canAlert(w: PageWatch, cents: number): boolean {
    if (this.now() - w.lastAlertAt >= REALERT_MS) return true;
    return w.lastAlertCents === null || cents < w.lastAlertCents;
  }

  /**
   * Lee la página, compara con la referencia y la actualiza. No lanza: devuelve el resultado.
   * `fetchHtml` (opcional) devuelve el HTML crudo; se usa solo en fichas de las 7 tiendas
   * del vigilante, donde la lectura es estructurada con el extractor de consenso de
   * pricewatch. Sin `fetchHtml`, o fuera de esas tiendas, sigue la heurística de texto.
   */
  async check(
    w: PageWatch,
    fetchText: (url: string) => Promise<string>,
    fetchHtml?: (url: string) => Promise<string>,
  ): Promise<CheckOutcome> {
    const store = storeForUrl(w.url);
    if (!w.keyword && store && fetchHtml) {
      let html: string;
      try {
        html = await fetchHtml(w.url);
      } catch (err) {
        return this.fail(w, err instanceof Error ? err.message : String(err));
      }
      if (isBlockedPage(200, html)) {
        return this.fail(
          w,
          'la tienda me está poniendo un captcha o un bloqueo; no se pudo comprobar el precio',
        );
      }
      const ext = extractReading(store, html);
      if (ext.cents === null) {
        return this.fail(w, 'no encuentro un precio claro en la ficha; no se pudo comprobar');
      }
      if (!ext.reliable) {
        return this.fail(
          w,
          'las fuentes de precio de la página no coinciden; no doy el dato por bueno',
        );
      }
      const cents = ext.cents;
      const prevReadings = this.readings(w.id);
      const prev = prevReadings[prevReadings.length - 1];
      this.recordReading(w.id, cents, ext.inStock);
      const value = eur(cents);
      this.db
        .prepare(
          'UPDATE page_watches SET last_value = ?, failures = 0, last_checked_at = ? WHERE id = ?',
        )
        .run(value, this.now(), w.id);
      if (w.targetCents !== null && cents <= w.targetCents) {
        // Aviso al cruzar el umbral a la baja (o si la primera lectura ya está por debajo).
        if (!prev || prev.cents > w.targetCents) {
          this.markAlert(w.id, cents);
          return { kind: 'target', cents, targetCents: w.targetCents, inStock: ext.inStock };
        }
      }
      if (w.dropPct !== null && prevReadings.length > 0) {
        const referenceCents =
          prevReadings.length >= 3 ? median(prevReadings.map((r) => r.cents)) : (prev?.cents ?? 0);
        const referenceKind = prevReadings.length >= 3 ? 'mediana' : 'ultima';
        if (referenceCents > 0) {
          const drop = ((referenceCents - cents) / referenceCents) * 100;
          if (drop + 1e-9 >= w.dropPct && this.canAlert(w, cents)) {
            this.markAlert(w.id, cents);
            return {
              kind: 'drop',
              cents,
              referenceCents,
              referenceKind,
              dropPct: Math.round(drop * 10) / 10,
              inStock: ext.inStock,
            };
          }
        }
      }
      // Sin histórico estructurado previo: primera lectura, nueva referencia silenciosa.
      // (Si la vigilancia viene de la heurística de texto, comparar métodos distintos
      // daría un "cambio" falso.)
      if (!prev) return { kind: 'baseline', value };
      const prevValue = eur(prev.cents);
      if (prevValue === value) return { kind: 'unchanged', value };
      return { kind: 'changed', from: prevValue, to: value, inStock: ext.inStock };
    }
    let text: string;
    try {
      text = await fetchText(w.url);
    } catch (err) {
      return this.fail(w, err instanceof Error ? err.message : String(err));
    }
    const value = watchValue(text, w.keyword);
    this.db
      .prepare(
        'UPDATE page_watches SET last_value = ?, failures = 0, last_checked_at = ? WHERE id = ?',
      )
      .run(value, this.now(), w.id);
    if (!w.lastValue) return { kind: 'baseline', value };
    if (value.startsWith('feed:')) {
      // Feed: solo cuentan las entradas nuevas; una que sale del final no es un cambio.
      // Una lectura anterior que no era de feed (versión vieja) es solo la nueva referencia.
      if (!w.lastValue.startsWith('feed:')) return { kind: 'baseline', value };
      const seen = feedKeys(w.lastValue);
      const newItems = (parseFeedItems(text) ?? []).filter((it) => !seen.has(feedKey(it)));
      if (newItems.length === 0) return { kind: 'unchanged', value };
      return { kind: 'changed', from: w.lastValue, to: value, newItems };
    }
    if (sameWatchValue(value, w.lastValue)) return { kind: 'unchanged', value };
    return { kind: 'changed', from: w.lastValue, to: value };
  }
}

const SPARK_BARS = '▁▂▃▄▅▆▇█';

/** Mínima expresión de evolución: cada barra es una lectura (vieja -> reciente). */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return SPARK_BARS[3]?.repeat(values.length) ?? '';
  return values.map((v) => SPARK_BARS[Math.round(((v - min) / (max - min)) * 7)] ?? '').join('');
}

function stockText(inStock: boolean | null | undefined): string {
  if (inStock === true) return ' · en stock';
  if (inStock === false) return ' · ojo: consta agotado';
  return ' · stock sin confirmar';
}

/** Mensaje en español para Telegram; honesto sobre qué se comparó. */
export function describeChange(w: PageWatch, o: CheckOutcome): string | null {
  const name = w.label || w.url;
  if (o.kind === 'changed' && w.keyword) {
    return o.to === 'presente'
      ? `Ahora aparece "${w.keyword}" en ${name}\n${w.url}`
      : `Ya no veo "${w.keyword}" en el texto que leo de ${name} (puede cargarse con JavaScript o estar bloqueado, compruébalo)\n${w.url}`;
  }
  if (o.kind === 'changed' && o.to.startsWith('feed:')) {
    const items = o.newItems ?? [];
    if (items.length === 0) return `Hay entradas nuevas en ${name}\n${w.url}`;
    const shown = items
      .slice(0, 5)
      .map((it) => `• ${it.title || '(sin título)'}${it.link ? `\n  ${it.link}` : ''}`);
    const more = items.length > 5 ? `\n…y ${items.length - 5} más` : '';
    const n = items.length === 1 ? '1 entrada nueva' : `${items.length} entradas nuevas`;
    return `${n} en ${name}:\n${shown.join('\n')}${more}`;
  }
  if (o.kind === 'changed') {
    const textual = o.to.startsWith('texto:') || o.from.startsWith('texto:');
    if (textual) {
      return `La página que vigilas ha cambiado (no encuentro un precio claro, solo veo que el texto es distinto): ${name}\n${w.url}`;
    }
    if (storeForUrl(w.url)) {
      return `Cambio de precio en ${name}: ${o.from} -> ${o.to}${stockText(o.inStock)}\n${w.url}\n(Precio de la ficha, verificado con varias fuentes de la propia página.)`;
    }
    return `Cambio de precio en ${name}: ${o.from} -> ${o.to}\n${w.url}\n(Sigo el primer precio en € de la página; puede no ser el del producto.)`;
  }
  if (o.kind === 'target') {
    return `Objetivo conseguido en ${name}: ${eur(o.cents)} (querías que bajara de ${eur(o.targetCents)})${stockText(o.inStock)}\n${w.url}`;
  }
  if (o.kind === 'drop') {
    const ref =
      o.referenceKind === 'mediana'
        ? `la mediana de tu histórico (${eur(o.referenceCents)})`
        : `la última lectura (${eur(o.referenceCents)})`;
    return `Bajada del ${o.dropPct} % en ${name}: ${eur(o.cents)} frente a ${ref}${stockText(o.inStock)}\n${w.url}`;
  }
  if (o.kind === 'error' && o.notify) {
    return `No consigo leer ${name} desde hace ${o.failures} comprobaciones (${readFailureCause(o.message)}). Sigo intentándolo, pero ahora mismo no te puedo avisar de cambios.`;
  }
  return null;
}

/**
 * Causa en castellano para el aviso «No consigo leer…». Antes salía el error
 * tal cual («fetch failed», «This operation was aborted», «HTTP 403 Forbidden»);
 * el texto crudo se queda en la base, el chat recibe una frase corta.
 */
export function readFailureCause(message: string): string {
  const m = message.toLowerCase();
  const http = /\b(?:http|status)\s*(\d{3})\b/.exec(m);
  if (http) {
    const code = Number(http[1]);
    if (code === 404 || code === 410) return 'la página ya no existe';
    if (code === 401 || code === 403) return 'la web no me deja entrar';
    if (code === 429) return 'la web me pide que espere';
    if (code >= 500) return 'la web da error ahora mismo';
    return `la web responde con error ${code}`;
  }
  if (/abort|timed? ?out|timeout|etimedout/.test(m)) return 'la web tarda demasiado en responder';
  if (/fetch failed|enotfound|eai_again|econnrefused|econnreset|network|socket|und_err/.test(m)) {
    return 'sin conexión o la web no responde';
  }
  if (/captcha|robot|bot detect/.test(m)) return 'la web me pide demostrar que no soy un robot';
  // Mensajes propios ya en castellano (p. ej. «no encuentro un precio claro…»).
  if (
    /^[a-záéíóúñü ,;.()0-9%€-]+$/i.test(message) &&
    /[áéíóúñ]|\b(no|la|el|en|de)\b/i.test(message)
  ) {
    return message.slice(0, 120);
  }
  return 'no sé por qué; queda en el registro';
}

const fmtDay = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid' });
const fmtDayTime = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Último valor guardado, legible: un precio tal cual; el resumen interno de texto o de
 * feed (un hash) no le dice nada al usuario.
 */
export function watchValueText(v: string): string {
  if (!v) return 'pendiente';
  if (v === 'presente') return 'la palabra aparece';
  if (v === 'ausente') return 'la palabra no aparece';
  if (v.startsWith('texto:')) return 'texto sin precio claro';
  if (v.startsWith('feed:')) {
    const n = v.slice('feed:'.length).split(',').filter(Boolean).length;
    return n === 1 ? 'feed con 1 entrada' : `feed con ${n} entradas`;
  }
  return v;
}

/** Ficha de una vigilancia para /precio: último valor, histórico y avisos configurados. */
export function describeWatch(
  w: PageWatch,
  s: WatchSummary | null,
  now: number = Date.now(),
): string {
  const lines = [`${w.label || w.url} (id ${w.id})`, w.url];
  if (!s) {
    lines.push(`Aún no tengo lecturas de precio; último valor: ${watchValueText(w.lastValue)}.`);
  } else {
    lines.push(
      `Último: ${eur(s.lastCents)} (${fmtDayTime.format(s.lastAt)}${s.lastInStock === null ? '' : s.lastInStock ? ', en stock' : ', consta agotado'})`,
    );
    lines.push(
      `Histórico: ${s.readings} lecturas desde ${fmtDay.format(s.firstAt)} · mín ${eur(s.minCents)} · mediana ${eur(s.medianCents)} · máx ${eur(s.maxCents)}`,
    );
    if (s.sparkline) lines.push(s.sparkline);
  }
  if (w.targetCents !== null) lines.push(`Objetivo: te aviso si baja de ${eur(w.targetCents)}.`);
  if (w.dropPct !== null) lines.push(`Te aviso si baja un ${w.dropPct} % o más.`);
  if (w.mutedUntil > now) {
    lines.push(
      `🔕 Silenciada hasta ${fmtDayTime.format(w.mutedUntil)} (/vigila avisar ${w.id} para quitarlo).`,
    );
  }
  return lines.join('\n');
}

export interface VigilaArgs {
  url: string;
  keyword: string;
  label: string;
  /** objetivo=500€ -> 50000 (céntimos). null = no se pidió. */
  targetCents: number | null;
  /** baja=15% -> 15. null = no se pidió. */
  dropPct: number | null;
}

/**
 * `<enlace> [objetivo=500€] [baja=15%] [palabra=agotado | palabra="sin stock"] [nombre libre]`.
 * Acepta comillas tipográficas (el móvil las pone solo). Devuelve null si no hay enlace;
 * lanza si un objetivo o un porcentaje no se entienden (mejor decírselo que ignorarlo).
 */
export function parseVigilaArgs(args: string): VigilaArgs | null {
  const trimmed = args.trim();
  const m = /^(\S+)\s*(.*)$/s.exec(trimmed);
  if (!m?.[1]) return null;
  let rest = m[2] ?? '';
  let keyword = '';
  let targetCents: number | null = null;
  let dropPct: number | null = null;
  const kw = /palabra\s*=\s*(?:["“”«]([^"“”»]+)["“”»]|(\S+))/i.exec(rest);
  if (kw) {
    keyword = (kw[1] ?? kw[2] ?? '').trim();
    rest = rest.replace(kw[0], ' ');
  }
  const obj = /objetivo\s*=\s*(\S+(?:\s?€)?)/i.exec(rest);
  if (obj?.[1]) {
    const raw = obj[1].replace(/[€\s]/g, '');
    const cents = parseMachinePrice(raw);
    if (cents === null || cents <= 0) {
      throw new Error(
        `No entiendo el objetivo "${obj[1]}". Ponlo en euros, por ejemplo: objetivo=500€ u objetivo=1.299,50€`,
      );
    }
    targetCents = cents;
    rest = rest.replace(obj[0], ' ');
  }
  const drop = /baja\s*=\s*(\d{1,3}(?:[.,]\d+)?)\s*%?/i.exec(rest);
  if (drop?.[1]) {
    const pct = Number(drop[1].replace(',', '.'));
    if (!Number.isFinite(pct) || pct < 1 || pct > 95) {
      throw new Error(`El porcentaje de bajada tiene que estar entre 1 y 95: baja=15%`);
    }
    dropPct = pct;
    rest = rest.replace(drop[0], ' ');
  }
  return {
    url: m[1],
    keyword,
    label: rest.replace(/\s+/g, ' ').trim(),
    targetCents,
    dropPct,
  };
}
