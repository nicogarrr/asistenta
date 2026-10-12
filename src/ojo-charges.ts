/**
 * Ojo de águila, parte 3b: cargos raros, inferidos del correo.
 *
 * Por remitente (dominio; dirección completa si es un correo gratuito) se guarda el
 * historial de importes de los cargos que cuentan los correos. Un cargo nuevo se marca
 * como raro SOLO con prueba positiva:
 *  - "subida": hay >= 3 cargos anteriores del mismo remitente y el importe supera 1,5 veces
 *    su mediana, o
 *  - "nuevo": ningún cargo anterior del remitente en el historial.
 * Un correo cuenta como cargo solo si tiene una palabra de cobro y EXACTAMENTE un importe
 * distinto en euros (varios importes = ambiguo = no se infiere nada). Las promociones no
 * cuentan. La primera ejecución solo siembra el historial: nada de lo anterior se avisa.
 * Todo se dice como "inferido del correo": es una lectura heurística, no un hecho bancario.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { MailMessage } from './mail/types.js';

export const SPIKE_FACTOR_NUM = 3; // > 1,5 x mediana  <=>  cents * 2 > mediana * 3
export const SPIKE_FACTOR_DEN = 2;
export const MIN_HISTORY = 3;
export const MAX_CHARGE_ALERTS = 3;
const BASELINE_KEY = 'charges_baseline_at';
/** Un cargo raro más viejo que esto ya no se avisa. */
export const ALERT_MAX_AGE_MS = 7 * 86_400_000;

const CHARGE_RE =
  /\b(cargo|cargos|hemos cobrado|te hemos cobrado|se ha cobrado|cobro|recibo|factura|importe|pago recibido|charged|payment received|receipt|invoice|billed)\b/;
const PROMO_RE = /\b(oferta|descuento|promocion|black friday|cupon|rebajas|sorteo|gana|ahorra)\b/;
const FREEMAIL = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|proton|protonmail)\./;

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

const NUM = String.raw`(?:\d{1,3}(?:[.\s]\d{3})+(?:[,.]\d+)?|\d+(?:[,.]\d+)?)`;
const SIGN = String.raw`([-\u2212(]\s?)?`;
const TOKEN_AFTER = new RegExp(`${SIGN}(${NUM})\\s?(?:\u20ac|eur\\b|euros?\\b)`, 'gi');
const TOKEN_BEFORE = new RegExp(`${SIGN}(?:\u20ac|eur\\b)\\s?(${NUM})`, 'gi');
const FOREIGN_RE = /[$\u00a3]|\b(usd|gbp|dolares?|libras?)\b/i;
const STRICT_THOUSANDS = /^(\d{1,3}(?:[.\s]\d{3})+)(?:[,.](\d{2}))?$/;
const STRICT_PLAIN = /^(\d+)(?:[,.](\d{2}))?$/;

/** Estricto: miles opcionales y 0 o 2 decimales; cualquier otra forma es "no soportado". */
function strictCents(token: string): number | null {
  const m = STRICT_THOUSANDS.exec(token) ?? STRICT_PLAIN.exec(token);
  if (!m) return null;
  const whole = (m[1] ?? '').replace(/[.\s]/g, '');
  if (!/^\d{1,7}$/.test(whole)) return null;
  return Number(whole) * 100 + Number(m[2] ?? '0');
}

/**
 * Todos los importes monetarios del texto. `bad` = hay algo monetario que no se sabe leer
 * (negativo o entre paréntesis, otra divisa, formato raro): entonces NO se infiere nada.
 * Los enteros ("100 €") son importes: no se pueden ignorar por no tener decimales.
 */
export function scanMoney(text: string): { cents: number[]; bad: boolean } {
  const out = new Set<number>();
  let bad = FOREIGN_RE.test(text);
  for (const re of [TOKEN_AFTER, TOKEN_BEFORE]) {
    for (const m of text.matchAll(re)) {
      if (m[1]) bad = true; // signo menos o paréntesis: abono, reembolso o ambiguo
      const c = strictCents(m[2] ?? '');
      if (c === null || c <= 0) bad = true;
      else out.add(c);
    }
  }
  return { cents: [...out], bad };
}

export function amountsIn(text: string): number[] {
  return scanMoney(text).cents;
}

/** Remitente estable: dominio, o la dirección completa si es un correo gratuito. */
export function senderKey(from: string): string | null {
  const m = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(from);
  if (!m) return null;
  const domain = (m[2] ?? '').toLowerCase();
  if (FREEMAIL.test(domain)) return `${(m[1] ?? '').toLowerCase()}@${domain}`;
  return domain;
}

export interface ParsedCharge {
  sender: string;
  cents: number;
}

export function parseCharge(message: MailMessage): ParsedCharge | null {
  const sender = senderKey(message.from ?? '');
  if (!sender) return null;
  const raw = `${message.subject ?? ''} ${message.text ?? ''}`;
  const folded = fold(raw);
  if (!CHARGE_RE.test(folded) || PROMO_RE.test(folded)) return null;
  const { cents, bad } = scanMoney(raw);
  if (bad || cents.length !== 1) return null; // ninguno, varios o ilegible: no se infiere nada
  return { sender, cents: cents[0] as number };
}

export function initChargeStore(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_charges (
      msg_id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      cents INTEGER NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      median_cents INTEGER,
      n_prior INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
}

export function chargeBaseline(db: DatabaseSync): number | null {
  initChargeStore(db);
  const row = db.prepare('SELECT value FROM vigilante_settings WHERE key = ?').get(BASELINE_KEY) as
    | { value: string }
    | undefined;
  const n = Number(row?.value);
  return row && Number.isFinite(n) ? n : null;
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2
    ? (s[mid] as number)
    : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

/**
 * Incorpora correos al historial, de más antiguo a más reciente. Idempotente por id de
 * correo. Lo anterior a la línea base (o toda la primera ejecución) solo siembra historial.
 */
export function ingestCharges(
  db: DatabaseSync,
  messages: readonly MailMessage[],
  now: number,
): void {
  initChargeStore(db);
  let baseline = chargeBaseline(db);
  // La primera llamada SOLO siembra, sea cual sea la fecha de cada correo.
  const seedOnly = baseline === null;
  if (baseline === null) {
    baseline = now;
    db.prepare('INSERT INTO vigilante_settings (key, value) VALUES (?, ?)').run(
      BASELINE_KEY,
      String(now),
    );
  }
  const exists = db.prepare('SELECT 1 AS x FROM vigilante_charges WHERE msg_id = ?');
  const priorsOf = db.prepare(
    'SELECT cents FROM vigilante_charges WHERE sender = ? AND at <= ? AND msg_id <> ?',
  );
  const ins = db.prepare(
    'INSERT INTO vigilante_charges (msg_id, sender, cents, at, status, reason, median_cents, n_prior, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const ordered = [...messages].sort((a, b) => a.at - b.at);
  for (const m of ordered) {
    if (!m.id || !Number.isFinite(m.at) || exists.get(m.id)) continue;
    // Fecha futura: no es un cargo ya hecho. No se guarda; se reevalúa cuando llegue su hora.
    if (m.at > now && !seedOnly) continue;
    const parsed = parseCharge(m);
    if (!parsed) continue;
    const priors = (priorsOf.all(parsed.sender, m.at, m.id) as Array<{ cents: number }>).map(
      (r) => r.cents,
    );
    if (seedOnly || m.at < baseline) {
      ins.run(m.id, parsed.sender, parsed.cents, m.at, 'base', null, null, priors.length, now);
      continue;
    }
    const med = priors.length > 0 ? median(priors) : null;
    if (
      priors.length >= MIN_HISTORY &&
      med !== null &&
      parsed.cents * SPIKE_FACTOR_DEN > med * SPIKE_FACTOR_NUM
    ) {
      ins.run(m.id, parsed.sender, parsed.cents, m.at, 'aviso', 'subida', med, priors.length, now);
    } else if (priors.length === 0) {
      ins.run(m.id, parsed.sender, parsed.cents, m.at, 'aviso', 'nuevo', null, 0, now);
    } else {
      ins.run(m.id, parsed.sender, parsed.cents, m.at, 'ok', null, med, priors.length, now);
    }
  }
}

export interface ChargeAlert {
  msgId: string;
  sender: string;
  cents: number;
  at: number;
  reason: 'subida' | 'nuevo';
  medianCents: number | null;
  nPrior: number;
}

/** Cargos raros pendientes de avisar (recientes), los más recientes primero. */
export function pendingChargeAlerts(db: DatabaseSync, now: number): ChargeAlert[] {
  initChargeStore(db);
  const rows = db
    .prepare(
      "SELECT msg_id AS msgId, sender, cents, at, reason, median_cents AS medianCents, n_prior AS nPrior FROM vigilante_charges WHERE status = 'aviso' AND at >= ? ORDER BY at DESC LIMIT ?",
    )
    .all(now - ALERT_MAX_AGE_MS, MAX_CHARGE_ALERTS) as unknown as ChargeAlert[];
  return rows;
}

export function markChargesNotified(db: DatabaseSync, ids: readonly string[]): void {
  if (ids.length === 0) return;
  initChargeStore(db);
  const upd = db.prepare(
    "UPDATE vigilante_charges SET status = 'avisado' WHERE msg_id = ? AND status = 'aviso'",
  );
  for (const id of ids) upd.run(id);
}

const eur = (cents: number): string =>
  `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export function formatChargeAlerts(alerts: readonly ChargeAlert[], timeZone: string): string {
  const lines = alerts.map((a) => {
    const day = new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'long',
      timeZone,
    }).format(new Date(a.at));
    const why =
      a.reason === 'subida' && a.medianCents !== null
        ? `más de 1,5 veces lo habitual (mediana ${eur(a.medianCents)} en ${a.nPrior} cargos)`
        : 'primer cargo que veo de este remitente';
    return `• ${a.sender.slice(0, 60)}: ${eur(a.cents)}, ${why} — correo del ${day}`;
  });
  return `💳 Cargo raro (inferido del correo, puede no ser un cargo real): ${alerts.length === 1 ? '1 aviso' : `${alerts.length} avisos`}\n${lines.join('\n')}`;
}
