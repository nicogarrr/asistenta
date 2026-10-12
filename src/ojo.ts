/**
 * Ojo de águila, parte 1: recordatorios escalonados, conflictos de agenda y
 * horas de silencio. Funciones puras sobre los hallazgos del vigilante: nada de
 * red, ni LLM, ni reloj implícito (el `now` se inyecta siempre).
 *
 * Reglas, y por qué:
 *
 * - UNA ETAPA = UN AVISO. T-24h y T-2h de un mismo hallazgo se guardan con clave
 *   propia; un hallazgo descubierto tarde NO recibe luego los recordatorios que ya
 *   quedaron cubiertos por el propio aviso de descubrimiento, y si el daemon
 *   estuvo apagado solo sale la etapa más cercana, no las dos.
 * - LO VENCIDO NO SE RECUERDA. Una etapa solo es válida entre su instante y el
 *   vencimiento (la hora, o el final del día si no hay hora): un recordatorio
 *   tardío es peor que ninguno.
 * - NUNCA SE INVENTA UNA HORA. Sin hora (o todo el día) solo hay recordatorio
 *   "mañana", a las 09:00 locales del día anterior, y nunca T-2h.
 * - UN CONFLICTO ES SOLAPE REAL ENTRE DOS COSAS CON HORA. Los eventos de todo el
 *   día y los que no tienen hora no chocan con nada. Un evento puntual (sin fin)
 *   ocupa un instante: choca si cae dentro de otro o coincide con su inicio.
 * - EL SILENCIO NO ES OLVIDO. Durante las horas de silencio lo no crítico espera
 *   (no se marca como avisado) y sale al terminar. Crítico = pago o plazo con
 *   hora que vence en menos de 2 h. Citas y viajes esperan: su recordatorio de
 *   24 h ya salió de día y despertar por una cita no lo ha pedido nadie.
 */

import { createHash } from 'node:crypto';
import { zonedDayStart, zonedParts } from './agenda/ics.js';
import type { AgendaItem } from './agenda/unified.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Tipos con recordatorio escalonado: plazo, pago y cita. Un viaje ya tiene su billete. */
export const REMINDER_KINDS: readonly string[] = ['deadline', 'payment', 'meeting'];

/** Tipos que pueden chocar entre sí. */
export const CONFLICT_KINDS: readonly string[] = ['meeting', 'travel'];

/** Tipos que pueden despertarte dentro de las horas de silencio. */
export const CRITICAL_KINDS: readonly string[] = ['payment', 'deadline'];

export const CRITICAL_WINDOW_MS = 2 * HOUR_MS;
export const MAX_CONFLICTS = 3;

export type ReminderStage = 't24' | 't2';

export interface QuietHours {
  /** Hora local de inicio (0-23). */
  startHour: number;
  /** Hora local de fin (0-23), exclusiva. Si start > end cruza la medianoche. */
  endHour: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 22, endHour: 8 };

function isTimed(item: AgendaItem): boolean {
  return item.at != null && !item.allDay && item.timed !== false;
}

/** Cuándo vence el hallazgo: su hora, o el final de su día si no tiene hora. */
export function dueInstant(item: AgendaItem, timeZone: string): number | null {
  if (item.at == null) return null;
  if (isTimed(item)) return item.at;
  const dayStart = zonedDayStart(item.at, timeZone);
  return zonedDayStart(dayStart + DAY_MS + 6 * HOUR_MS, timeZone);
}

/** Instante en que toca cada etapa; solo las que el hallazgo admite. */
export function stageInstants(
  item: AgendaItem,
  timeZone: string,
): Array<{ stage: ReminderStage; at: number }> {
  if (item.at == null || !REMINDER_KINDS.includes(item.kind)) return [];
  if (isTimed(item)) {
    return [
      { stage: 't24', at: item.at - DAY_MS },
      { stage: 't2', at: item.at - 2 * HOUR_MS },
    ];
  }
  const dayStart = zonedDayStart(item.at, timeZone);
  const prevStart = zonedDayStart(dayStart - 1, timeZone);
  return [{ stage: 't24', at: prevStart + 9 * HOUR_MS }];
}

/** Etapas ya alcanzadas y todavía vigentes (instante <= ahora < vencimiento), de la más lejana a la más cercana. */
export function dueStages(item: AgendaItem, timeZone: string, now: number): ReminderStage[] {
  const due = dueInstant(item, timeZone);
  if (due == null || now >= due) return [];
  return stageInstants(item, timeZone)
    .filter((s) => s.at <= now)
    .map((s) => s.stage);
}

export function stageKey(findingKey: string, stage: ReminderStage): string {
  return `${findingKey}:${stage}`;
}

/** Hora local dentro de las horas de silencio. */
export function inQuietHours(now: number, quiet: QuietHours, timeZone: string): boolean {
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  const p = zonedParts(now, timeZone);
  const h = p.hour;
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/** Pago o plazo con hora que vence en las próximas 2 h. */
export function isCritical(item: AgendaItem, now: number): boolean {
  if (!CRITICAL_KINDS.includes(item.kind) || !isTimed(item) || item.at == null) return false;
  const left = item.at - now;
  return left > 0 && left <= CRITICAL_WINDOW_MS;
}

export interface Conflict {
  key: string;
  a: AgendaItem;
  b: AgendaItem;
}

function span(item: AgendaItem): { start: number; end: number } {
  const start = item.at as number;
  const end = item.end != null && item.end > start ? item.end : start + 1;
  return { start, end };
}

/**
 * Pares de cosas con hora que se pisan, aún no terminadas a `now`. `keyOf` es la
 * clave estable del hallazgo (la del vigilante), de modo que el par tiene
 * identidad aunque cambie el orden en que llegan.
 */
export function findConflicts(
  items: readonly AgendaItem[],
  keyOf: (item: AgendaItem) => string,
  now: number,
): Conflict[] {
  const cand = items
    .filter(
      (i) => i.at != null && isTimed(i) && CONFLICT_KINDS.includes(i.kind) && span(i).end > now,
    )
    .sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i] as AgendaItem;
      const b = cand[j] as AgendaItem;
      const sa = span(a);
      const sb = span(b);
      if (sb.start >= sa.end) break; // ordenado por inicio: ya no hay más solapes con a
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka === kb) continue; // la misma cosa vista dos veces no choca consigo misma
      const [lo, hi] = ka < kb ? [ka, kb] : [kb, ka];
      const key = `c:${createHash('sha256').update(`${lo}|${hi}`).digest('hex').slice(0, 24)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, a, b });
    }
  }
  return out;
}

function clock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(at));
}

function clean(title: string, max: number): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, max) || '(sin título)';
}

function range(item: AgendaItem, timeZone: string): string {
  const s = clock(item.at as number, timeZone);
  return item.end != null && item.end > (item.at as number)
    ? `${s}-${clock(item.end, timeZone)}`
    : s;
}

export function formatConflicts(
  conflicts: readonly Conflict[],
  timeZone: string,
  max = 90,
): string {
  const day = (at: number): string =>
    new Intl.DateTimeFormat('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone,
    }).format(new Date(at));
  const lines = conflicts.map(
    (c) =>
      `• ${day(c.a.at as number)}: «${clean(c.a.title, max)}» (${range(c.a, timeZone)}) se pisa con «${clean(c.b.title, max)}» (${range(c.b, timeZone)})`,
  );
  return `⚠️ Conflicto de agenda${conflicts.length > 1 ? ` (${conflicts.length})` : ''}\n${lines.join('\n')}`;
}

/** "en 2 h", "en 35 min", "mañana": relativo y honesto, nunca una hora inventada. */
export function whenRelative(item: AgendaItem, stage: ReminderStage, now: number): string {
  if (stage === 't24' && !isTimed(item)) return 'mañana (sin hora)';
  const left = (item.at as number) - now;
  if (left >= 3 * HOUR_MS) return `en ${Math.round(left / HOUR_MS)} h`;
  if (left >= HOUR_MS) {
    const h = Math.floor(left / HOUR_MS);
    const m = Math.round((left - h * HOUR_MS) / 60_000);
    return m > 0 ? `en ${h} h ${m} min` : `en ${h} h`;
  }
  return `en ${Math.max(1, Math.round(left / 60_000))} min`;
}
