import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from '../datecontext.js';
import { paths } from '../paths.js';
import { type ModelCaps, resolveModelCaps } from './models.js';

/**
 * Consumo real de tokens y coste, por sesion y por dia.
 *
 * La persistencia es JSONL y una linea por llamada, en
 * `paths.state/log/usage-<YYYY-MM-DD>.jsonl`. Se escribe con append: el
 * acumulador no necesita releer ni reescribir el fichero entero, y una linea
 * rota (proceso matado a mitad de escritura) no invalida las anteriores.
 *
 * Reglas de dinero:
 * - Los precios del catalogo son EUR por millon de tokens.
 * - `eurFor` y los totales publicos redondean a centimos.
 * - Cada linea guarda costEur (centimos, visible) y costMicros (precision
 *   interna) para que muchas llamadas pequenas no se pierdan al redondear.
 *
 * Toda la escritura es best-effort: si el disco falla, el turno sigue. Nunca
 * se lanza una excepcion desde `recordUsage`.
 */

export type UsageKind = 'turn' | 'summary' | 'extraction';

export interface UsageInput {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens de entrada servidos desde cache; se facturan a precio de entrada. */
  cacheReadTokens?: number;
  kind: UsageKind;
  /**
   * PA_PRICE_* describen PA_MODEL. Otro modelo (el de /modelo, el de respaldo o
   * uno de PA_MODELS) se cobra con los precios de su ficha en el catálogo.
   * Sin indicar: solo se aplican si `model` es PA_MODEL (o va vacío).
   */
  priceOverrides?: boolean;
}

/** Una linea del JSONL. `day` es la fecha local que decide el fichero. */
export interface UsageRecord {
  ts: string;
  day: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  kind: UsageKind;
  /** Coste visible, redondeado a centimos. */
  costEur: number;
  /** Precision interna en microeuros, para no perder llamadas de < 1 centimo. */
  costMicros: number;
}

/** Agregado que devuelven usageToday() y usageForSession(). */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costEur: number;
  /** Numero de registro/llamadas sumadas. */
  calls: number;
}

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costEur: 0,
  calls: 0,
};

/** Fecha local YYYY-MM-DD (vive en datecontext; se reexporta por compatibilidad). */
export { localDay };

const USAGE_FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function usageFile(day: string): string {
  return join(paths.log, `usage-${day}.jsonl`);
}

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Precision de microeuro en disco; evita ruido de coma flotante sin perder coste. */
function roundMicros(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

/** Coste sin redondear (EUR); lo usan las escrituras y los agregados. */
function rawCost(
  usage: Pick<UsageInput, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>,
  caps: ModelCaps,
): number {
  const input = nonNegativeInt(usage.inputTokens) + nonNegativeInt(usage.cacheReadTokens);
  const output = nonNegativeInt(usage.outputTokens);
  return (input * caps.inputPerMTok) / 1_000_000 + (output * caps.outputPerMTok) / 1_000_000;
}

/**
 * Coste de un consumo con las capacidades/precios dados, redondeado a centimos.
 * Las lecturas de cache se cobran al precio de entrada: el catalogo no tiene
 * una tarifa de cache separada.
 */
export function eurFor(
  usage: Pick<UsageInput, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>,
  caps: ModelCaps,
): number {
  return roundCents(rawCost(usage, caps));
}

/**
 * Registra una llamada. Calcula el coste con el catalogo/precios vigentes y
 * anade una linea al fichero del dia local.
 *
 * Devuelve el registro aunque la escritura falle: el llamador puede mostrarlo
 * en memoria. No lanza nunca.
 */
export function recordUsage(input: UsageInput): UsageRecord {
  const day = localDay();
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : '';
  const model = typeof input?.model === 'string' ? input.model : '';
  const inputTokens = nonNegativeInt(input?.inputTokens);
  const outputTokens = nonNegativeInt(input?.outputTokens);
  const cacheReadTokens = nonNegativeInt(input?.cacheReadTokens);
  const kind: UsageKind =
    input?.kind === 'summary' || input?.kind === 'extraction' ? input.kind : 'turn';

  let rawEur = 0;
  try {
    const envOverrides =
      typeof input?.priceOverrides === 'boolean'
        ? input.priceOverrides
        : !model || model === (process.env.PA_MODEL?.trim() ?? '');
    rawEur = rawCost(
      { inputTokens, outputTokens, cacheReadTokens },
      resolveModelCaps({ model }, { envOverrides }),
    );
  } catch {
    // Un catalogo roto no puede impedir registrar los tokens.
    rawEur = 0;
  }
  rawEur = roundMicros(rawEur);

  const record: UsageRecord = {
    ts: new Date().toISOString(),
    day,
    sessionId,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    kind,
    costEur: roundCents(rawEur),
    costMicros: Math.round(rawEur * 1_000_000),
  };

  try {
    mkdirSync(paths.log, { recursive: true, mode: 0o700 });
    appendFileSync(usageFile(day), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort: disco lleno, permisos o ruta ocupada no tumban el turno.
  }
  return record;
}

/** Convierte una linea en un registro util; cualquier forma invalida se descarta. */
function parseRecord(value: unknown): UsageRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  const model = typeof raw.model === 'string' ? raw.model : '';
  const inputTokens = nonNegativeInt(raw.inputTokens);
  const outputTokens = nonNegativeInt(raw.outputTokens);
  const cacheReadTokens = nonNegativeInt(raw.cacheReadTokens);
  const kind: UsageKind = raw.kind === 'summary' || raw.kind === 'extraction' ? raw.kind : 'turn';
  const storedMicros = finiteNumber(raw.costMicros);
  const storedCost = finiteNumber(raw.costEur);
  let costMicros: number;
  if (storedMicros !== undefined) {
    costMicros = Math.round(storedMicros);
  } else if (storedCost !== undefined) {
    // Formato anterior (o escrito a mano) sin precision interna.
    costMicros = Math.round(storedCost * 1_000_000);
  } else {
    // Linea sin coste: se recalcula con el catalogo/precios actuales.
    try {
      costMicros = Math.round(
        rawCost({ inputTokens, outputTokens, cacheReadTokens }, resolveModelCaps({ model })) *
          1_000_000,
      );
    } catch {
      costMicros = 0;
    }
  }
  return {
    ts: typeof raw.ts === 'string' ? raw.ts : '',
    day: typeof raw.day === 'string' ? raw.day : '',
    sessionId: raw.sessionId,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    kind,
    costEur: roundCents(costMicros / 1_000_000),
    costMicros,
  };
}

/** Lee un JSONL tolerando lineas corruptas y ficheros ausentes. */
function readRecords(file: string): UsageRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = parseRecord(JSON.parse(line));
      if (record) out.push(record);
    } catch {
      // Linea corrupta: se ignora y se sigue con las demas.
    }
  }
  return out;
}

function aggregate(records: UsageRecord[]): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costMicros = 0;
  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    costMicros += record.costMicros;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    costEur: roundCents(costMicros / 1_000_000),
    calls: records.length,
  };
}

/** Consumo del dia local actual. */
export function usageToday(): UsageTotals {
  try {
    return aggregate(readRecords(usageFile(localDay())));
  } catch {
    return { ...ZERO_TOTALS };
  }
}

/**
 * Consumo acumulado de una sesion. Mira todos los `usage-*.jsonl`: una
 * conversacion puede cruzar la medianoche y su coste no debe resetearse.
 */
export function usageForSession(id: string): UsageTotals {
  if (!id) return { ...ZERO_TOTALS };
  try {
    const files = readdirSync(paths.log)
      .filter((name) => USAGE_FILE.test(name))
      .sort()
      .map((name) => join(paths.log, name));
    const records = files.flatMap((file) => readRecords(file)).filter((r) => r.sessionId === id);
    return aggregate(records);
  } catch {
    return { ...ZERO_TOTALS };
  }
}

/**
 * true si el coste de hoy supera `limitEur`.
 *
 * 0, undefined, negativo o no finito significa "sin limite" (desactivado), que
 * es el default del producto. Se compara el total ya redondeado a centimos.
 */
export function dailyBudgetExceeded(limitEur?: number): boolean {
  if (limitEur === undefined || !Number.isFinite(limitEur) || limitEur <= 0) return false;
  return usageToday().costEur > limitEur;
}

/** Totales de un informe con la precision interna para no perder centimos al sumar. */
export interface UsageReportTotals extends UsageTotals {
  costMicros: number;
}

export interface UsageReport {
  /** Dias del periodo, del mas reciente (hoy) al mas antiguo, con o sin consumo. */
  days: { day: string; totals: UsageReportTotals }[];
  /** Desglose por modelo del periodo, de mayor a menor coste (y tokens). */
  byModel: { model: string; totals: UsageReportTotals }[];
  total: UsageReportTotals;
  today: UsageReportTotals;
}

/** Tope del periodo de un informe: un mes de ficheros diarios. */
export const USAGE_REPORT_MAX_DAYS = 31;

function reportTotals(records: UsageRecord[]): UsageReportTotals {
  const base = aggregate(records);
  let costMicros = 0;
  for (const record of records) costMicros += record.costMicros;
  return { ...base, costMicros };
}

/**
 * Consumo de los ultimos `days` dias locales (hoy incluido), leido de los
 * JSONL diarios. Solo lectura y tolerante: un fichero ausente o una linea rota
 * cuentan como cero. `days` se acota a 1..USAGE_REPORT_MAX_DAYS.
 */
export function usageReport(days = 7, now: Date = new Date()): UsageReport {
  const span = Math.min(
    USAGE_REPORT_MAX_DAYS,
    Math.max(1, Number.isFinite(days) ? Math.floor(days) : 7),
  );
  const perDay: { day: string; records: UsageRecord[] }[] = [];
  for (let i = 0; i < span; i++) {
    // Mediodia local: restar dias nunca cruza mal un cambio de hora.
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    const day = localDay(date);
    perDay.push({ day, records: readRecords(usageFile(day)) });
  }
  const all = perDay.flatMap((d) => d.records);
  const models = new Map<string, UsageRecord[]>();
  for (const record of all) {
    const key = record.model || 'desconocido';
    const list = models.get(key);
    if (list) list.push(record);
    else models.set(key, [record]);
  }
  const byModel = [...models.entries()]
    .map(([model, records]) => ({ model, totals: reportTotals(records) }))
    .sort(
      (a, b) =>
        b.totals.costMicros - a.totals.costMicros ||
        b.totals.totalTokens - a.totals.totalTokens ||
        a.model.localeCompare(b.model),
    );
  const days_ = perDay.map((d) => ({ day: d.day, totals: reportTotals(d.records) }));
  return {
    days: days_,
    byModel,
    total: reportTotals(all),
    today: days_[0]?.totals ?? reportTotals([]),
  };
}
