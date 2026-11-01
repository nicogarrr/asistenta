import { wallClock, zonedTime } from '../datecontext.js';
import { foldAccents } from '../text.js';

/**
 * When a promise the user made is due, read from the words around it.
 *
 * Lives here, next to the follow-up tracker that stores the result, rather than inside
 * the daemon's command router: it is a pure function of text and a clock.
 *
 * Deliberately rough: a follow-up that fires on the wrong day is still useful, and the
 * tracker re-reports anything unresolved. But a follow-up that fires AFTER the
 * deadline the user named is worse than none - "antes del 8" said on the 6th used to
 * become "in 7 days", the 13th, and the nudge (one day before) arrived on the 12th,
 * four days late. Whatever names a calendar day is read as that day; only what cannot
 * be placed falls back to one week out.
 *
 * Calendar days are walked on the local calendar (`new Date(y, m, d + n, h, min)`), so
 * the wall-clock time of the promise survives a DST change instead of drifting an hour.
 */

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const MONTH_WORDS = Object.keys(MONTHS).join('|');

/** «en dos días», «dentro de una semana»: cuántos, dicho en palabras. */
const COUNT_WORD_VALUE: Record<string, number> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  quince: 15,
};
const COUNT_WORDS = Object.keys(COUNT_WORD_VALUE).join('|');

/**
 * Words that say "this has a date on it", matched against lowercase, accent-free text.
 * Closed list on purpose: a follow-up guessed from an ordinary sentence is a nudge the
 * user never asked for. A bare `1/2` is not a date ("tomo 1/2 pastilla"); `el 15/11` is.
 */
export const DATE_SIGNALS = new RegExp(
  String.raw`\b(vence\w*|ma[nñ]ana|pasado ma[nñ]ana|antes del|antes de|proxima semana|semana que viene|(?:en|dentro de) (?:\d{1,3}|${COUNT_WORDS}) (?:dias?|semanas?)|(?:el|del|hasta el) \d{1,2}[/.-]\d{1,2}|\d{1,2} de (?:${MONTH_WORDS})|(?:el )?dia \d{1,2}|(?:el |al |los |cada )?(?:proximo |proxima )?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?: que viene)?)\b`,
);

const DAY_MS = 86_400_000;

/** Lowercase and strip accents, so "mañana" and "manana" match the same pattern (shared helper in src/text.ts). */
export { foldAccents };

/**
 * "por la mañana" says when someone likes something, never when it is due. The phrase
 * is dropped before date matching so "prefiero el café por la mañana" does not become a
 * follow-up for tomorrow.
 */
export function withoutTimeOfDay(folded: string): string {
  return folded.replace(/\bpor la (?:manana|tarde|noche)\b/g, ' ');
}

/** True when the text carries one of the closed-list date signals. */
export function hasDateSignal(text: string): boolean {
  return DATE_SIGNALS.test(withoutTimeOfDay(foldAccents(text)));
}

/** `now` moved `days` calendar days on the local calendar, same wall-clock time. */
// Todo en la zona de Nico (PA_TIMEZONE), no en la del proceso: con el servidor en UTC
// «vence el viernes» dicho el sábado a las 00:30 de Madrid daba el viernes que acababa
// de pasar, y «mañana» cruzando el cambio de hora movía la hora de pared.
function subMinute(now: number): number {
  return ((now % 60_000) + 60_000) % 60_000;
}

function plusDays(now: number, days: number): number {
  const w = wallClock(new Date(now));
  return zonedTime(w.year, w.month, w.day + days, w.hour, w.minute) + subMinute(now);
}

/** A calendar day at `now`'s wall-clock time, or null when the day does not exist (31/11). */
function onDay(now: number, year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCMonth() !== month - 1) return null;
  const w = wallClock(new Date(now));
  const seconds = Math.floor(subMinute(now) / 1000) * 1000;
  return zonedTime(year, month, day, w.hour, w.minute) + seconds;
}

function startOfToday(now: number): number {
  const w = wallClock(new Date(now));
  return zonedTime(w.year, w.month, w.day);
}

/** Day and month with no year: this year, or next year once it has gone by. */
function nextDayMonth(now: number, month: number, day: number): number | null {
  const year = wallClock(new Date(now)).year;
  const thisYear = onDay(now, year, month, day);
  if (thisYear !== null && thisYear >= startOfToday(now)) return thisYear;
  return onDay(now, year + 1, month, day);
}

/** A day of the month with no month: this month, or the next month that has that day. */
function nextDayOfMonth(now: number, day: number): number | null {
  const w = wallClock(new Date(now));
  for (let ahead = 0; ahead < 3; ahead++) {
    // Date normalises month 12 to January of the next year.
    const first = new Date(Date.UTC(w.year, w.month - 1 + ahead, 1));
    const at = onDay(now, first.getUTCFullYear(), first.getUTCMonth() + 1, day);
    if (at !== null && at >= startOfToday(now)) return at;
  }
  return null;
}

export function estimateDueAt(text: string, now: number): number {
  const folded = withoutTimeOfDay(foldAccents(text));
  // "pasado mañana" is read first: both sentences contain the word "mañana".
  if (/\bpasado manana\b/.test(folded)) return plusDays(now, 2);
  if (/\bmanana\b/.test(folded)) return plusDays(now, 1);
  const inN = new RegExp(
    String.raw`\b(?:en|dentro de) (\d{1,3}|${COUNT_WORDS}) (dias?|semanas?)\b`,
  ).exec(folded);
  if (inN) {
    const said = inN[1] ?? '';
    const n = /^\d+$/.test(said) ? Number(said) : (COUNT_WORD_VALUE[said] ?? 7);
    return plusDays(now, (inN[2] ?? '').startsWith('semana') ? 7 * n : n);
  }
  // «el 15/11», «el 15-11-2026», «el 15.11.2026»: en España se escriben con barra, guion o
  // punto. Antes solo la barra: «te pago el 10-01-2027» caía en el día 10 de este mes.
  const slash = /\b(?:el|del|hasta el) (\d{1,2})([/.-])(\d{1,2})(?:\2(\d{2,4}))?\b/.exec(folded);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[3]);
    const rawYear = slash[4] ? Number(slash[4]) : undefined;
    const at =
      rawYear === undefined
        ? nextDayMonth(now, month, day)
        : onDay(now, rawYear < 100 ? 2000 + rawYear : rawYear, month, day);
    if (at !== null) return at;
  }
  const named = new RegExp(String.raw`\b(\d{1,2}) de (${MONTH_WORDS})\b`).exec(folded);
  if (named) {
    const at = nextDayMonth(now, MONTHS[named[2] ?? ''] ?? 0, Number(named[1]));
    if (at !== null) return at;
  }
  const dayName =
    /\b(?:(proximo|proxima) )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)( que viene)?\b/.exec(
      folded,
    );
  const target = dayName ? WEEKDAYS[dayName[2] ?? ''] : undefined;
  if (dayName && target !== undefined) {
    // Next occurrence, today included: "vence el viernes" said on a Friday is about
    // today. "El lunes que viene" / "el próximo lunes" said on a Monday is next week.
    let delta = (target - wallClock(new Date(now)).weekday + 7) % 7;
    if (delta === 0 && (dayName[1] || dayName[3])) delta = 7;
    return plusDays(now, delta);
  }
  // Not the day of a dd/mm or «N de <mes>» that did not parse (31/11, 30 de febrero).
  const dayOfMonth = /\b(?:antes del|del|el) (?:dia )?(\d{1,2})(?!\d|[/.-]\d)(?! de )/.exec(folded);
  if (dayOfMonth) {
    const at = nextDayOfMonth(now, Number(dayOfMonth[1]));
    if (at !== null) return at;
  }
  // Sin un día nombrado: «vence hoy», «antes de esta noche»: hoy. Antes caía en «dentro de una semana» y el
  // aviso llegaba siete días después del plazo.
  if (/\b(?:hoy|esta (?:tarde|noche))\b/.test(folded)) return now;
  // «a fin de mes», «antes de final de mes»: el último día de este mes. Antes, dicho el
  // 28, el aviso salía a los siete días, ya pasado el plazo.
  if (/\bfin(?:al)? de(?:l)? mes\b/.test(folded)) {
    const w = wallClock(new Date(now));
    const last = new Date(Date.UTC(w.year, w.month, 0)).getUTCDate();
    const at = onDay(now, w.year, w.month, last);
    if (at !== null) return at;
  }
  return now + 7 * DAY_MS;
}
