/**
 * Vigila una página web y avisa cuando cambia el precio (o el texto).
 *
 * Caso de uso real: "avísame si baja el precio de esto" o "dime cuando haya plazas".
 * Hasta ahora Asistenta solo reaccionaba a mensajes; esto le deja mirar por su cuenta.
 *
 * Decisiones, y por qué:
 * - Solo páginas públicas: el texto lo obtiene un `fetchText` inyectado (en producción,
 *   el mismo camino con control SSRF que la tool fetch). Este módulo no hace red.
 * - Una página tiene muchos precios (envío, recomendados, tachados). Se sigue el primer
 *   precio en € del texto, y se dice así: es una heurística, no un contrato. Si la
 *   página no tiene ningún precio se vigila el texto completo (hash).
 * - Un fallo de red NO es un cambio: se cuenta como error y solo se avisa tras varios
 *   seguidos, para no spamear ni ocultar que la vigilancia está rota.
 * - Un aviso por cambio: tras avisar, el valor nuevo pasa a ser la referencia.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

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
}

export type CheckOutcome =
  | { kind: 'baseline'; value: string }
  | { kind: 'unchanged'; value: string }
  | { kind: 'changed'; from: string; to: string }
  | { kind: 'error'; message: string; failures: number; notify: boolean };

const AMOUNT = String.raw`(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
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
    if (repeated || after.length === 3) {
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
  const parsed = parseAmount(m[1] ?? m[2] ?? '');
  // Ambiguous format: keep exactly what the page wrote rather than a made-up number.
  if (!parsed) return m[0].replace(/\s+/g, ' ').trim();
  return `${parsed[0]},${parsed[1]} €`;
}

/** Valor que se compara entre lecturas. */
export function watchValue(text: string): string {
  const price = extractPrice(text);
  if (price) return price;
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return `texto:${createHash('sha256').update(norm).digest('hex').slice(0, 16)}`;
}

/** Cuántos fallos seguidos antes de avisar de que la vigilancia no funciona. */
export const FAILURES_BEFORE_NOTICE = 3;
export const MAX_WATCHES_PER_SCOPE = 10;

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
  };
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
  }

  add(scope: string, url: string, label = ''): PageWatch {
    const existing = this.list(scope).find((w) => w.url === url);
    if (existing) return existing;
    if (this.list(scope).length >= MAX_WATCHES_PER_SCOPE) {
      throw new Error(
        `ya vigilas ${MAX_WATCHES_PER_SCOPE} páginas; quita alguna antes de añadir otra`,
      );
    }
    const id = randomUUID().slice(0, 8);
    this.db
      .prepare('INSERT INTO page_watches (id, scope, url, label, created_at) VALUES (?,?,?,?,?)')
      .run(id, scope, url, label.slice(0, 80), this.now());
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

  /** Todas las activas, para el planificador. */
  due(everyMs: number): PageWatch[] {
    return this.db
      .prepare('SELECT * FROM page_watches WHERE active = 1 AND last_checked_at <= ?')
      .all(this.now() - everyMs)
      .map((r) => row(r as Record<string, unknown>));
  }

  remove(scope: string, idOrPrefix: string): boolean {
    const w = this.list(scope).find((x) => x.id === idOrPrefix || x.id.startsWith(idOrPrefix));
    if (!w) return false;
    this.db.prepare('UPDATE page_watches SET active = 0 WHERE id = ?').run(w.id);
    return true;
  }

  /** Lee la página, compara con la referencia y la actualiza. No lanza: devuelve el resultado. */
  async check(w: PageWatch, fetchText: (url: string) => Promise<string>): Promise<CheckOutcome> {
    let text: string;
    try {
      text = await fetchText(w.url);
    } catch (err) {
      const failures = w.failures + 1;
      this.db
        .prepare('UPDATE page_watches SET failures = ?, last_checked_at = ? WHERE id = ?')
        .run(failures, this.now(), w.id);
      return {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        failures,
        // Se avisa una sola vez, al llegar al umbral.
        notify: failures === FAILURES_BEFORE_NOTICE,
      };
    }
    const value = watchValue(text);
    this.db
      .prepare(
        'UPDATE page_watches SET last_value = ?, failures = 0, last_checked_at = ? WHERE id = ?',
      )
      .run(value, this.now(), w.id);
    if (!w.lastValue) return { kind: 'baseline', value };
    if (value === w.lastValue) return { kind: 'unchanged', value };
    return { kind: 'changed', from: w.lastValue, to: value };
  }
}

/** Mensaje en español para Telegram; honesto sobre qué se comparó. */
export function describeChange(w: PageWatch, o: CheckOutcome): string | null {
  const name = w.label || w.url;
  if (o.kind === 'changed') {
    const textual = o.to.startsWith('texto:') || o.from.startsWith('texto:');
    return textual
      ? `La página que vigilas ha cambiado (no encuentro un precio claro, solo veo que el texto es distinto): ${name}\n${w.url}`
      : `Cambio de precio en ${name}: ${o.from} -> ${o.to}\n${w.url}\n(Sigo el primer precio en € de la página; puede no ser el del producto.)`;
  }
  if (o.kind === 'error' && o.notify) {
    return `No consigo leer ${name} desde hace ${o.failures} comprobaciones (${o.message}). Sigo intentándolo, pero ahora mismo no te puedo avisar de cambios.`;
  }
  return null;
}
