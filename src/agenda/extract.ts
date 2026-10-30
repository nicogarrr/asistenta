/**
 * Commitments mined out of the mailbox.
 *
 * WHY this file exists: the calendar only knows about events the user typed in
 * somewhere else. The confirmation of a train, the invoice, the appointment a hotel
 * or a bank sent by mail is where most of a person's week actually lives, and today
 * that mail is invisible to the agent. This turns a `MailMessage[]` - the shape
 * `src/mail/client.ts` already returns - into dated, typed commitments.
 *
 * THE RULE THAT MATTERS: never invent a date. There is no default "probably
 * tomorrow" and no "assume next week". A message with no date in it yields nothing,
 * because a wrong date is worse than a missing one: the user stops trusting the
 * agenda the first time it tells them a train leaves on a Tuesday when it left on
 * Wednesday.
 *
 * NOISE IS THE ENEMY. A mailbox is mostly newsletters, bank notices, receipts and
 * marketing, and a naive extractor proposes thirty things for every three real ones.
 * Both directions are handled explicitly:
 *
 *   1. HARD FILTERS - dropped, and no confidence can save them
 *      - No date in the text. Not a date, not a commitment. This is what keeps
 *        "tu pedido ha sido enviado" out of the agenda.
 *      - Already past. A meeting on the 3rd is not pending on the 5th.
 *      - Beyond `horizonDays`, or before the epoch: a date that parses into 1970 or
 *        2199 is a misparse, not a plan.
 *      - A date RANGE, "entre el 3 y el 10": a week the user did not choose, and
 *        exactly how every shipping notice is worded.
 *
 *   2. CONFIDENCE - kept, but only above `MIN_CONFIDENCE`
 *      Evidence is scored, never guessed. `score()` carries the whole table; the
 *      short version is that a spelled-out date (0.62) plus a clock time (0.22) plus
 *      a keyword that names the kind of thing (0.15) clears the bar, while a vague
 *      relative date on its own does not. An automated sender costs a little, since
 *      `no-reply@` is exactly where a real confirmation comes from - a penalty, never
 *      a rejection.
 *
 * TWO LANGUAGES, ONE FOLD. Everything is lowercased and stripped of accents before
 * matching, so "manana", "mañana" and "MAÑANA " are one pattern, while `03/10` and
 * `18:27` keep the separators that make them a date and an hour. The text the user
 * reads is never folded; only the copy the patterns run against.
 */

import { localTimeZone } from '../datecontext.js';
import type { MailMessage } from '../mail/types.js';
import { zonedAddDays, zonedDayKey, zonedParts, zonedTime } from './ics.js';

/** A commitment found in a mail, ready to be proposed to the user. */
export interface ExtractedCommitment {
  /** One line the user will recognise. */
  subject: string;
  /** Epoch ms, in the user's own zone. */
  at: number;
  kind: CommitmentKind;
  /** 0..1. Below `MIN_CONFIDENCE` nothing is proposed. */
  confidence: number;
  source: { messageId: string; from: string };
  /**
   * True when a clock time was read; false means "sometime that day", and `at` is
   * then a nominal 09:00 anchor rather than a promise about the clock. The agenda has
   * to tell those apart, because an item that prints 09:00 and does not start at
   * 09:00 is worse than one that admits it has no hour.
   */
  timed?: boolean;
  /**
   * True when the mail says the thing expires or renews ("caduca", "expires", "renueva"),
   * so the date is an expiry and gets 30/7/1-day notices. Only a positive match sets it.
   */
  expiry?: boolean;
  /** Which rules fired. For the report, and for working out why one went wrong. */
  because?: string;
}

export interface ExtractOptions {
  /** Epoch ms. Defaults to `Date.now()`. */
  now?: number;
  /** Default `MIN_CONFIDENCE`. */
  minConfidence?: number;
  /** How far ahead a date may sit and still be proposed. Default 180 days. */
  horizonDays?: number;
  /** Zone the words are read in. Defaults to `localTimeZone()`. */
  timeZone?: string;
}

/**
 * The floor, and the reason this extractor is allowed to answer "I found nothing":
 * under it a candidate is not a commitment, it is a coincidence.
 */
export const MIN_CONFIDENCE = 0.6;

/**
 * "Sometime that day". Deliberately early: an untimed item must not sort itself
 * after the 09:30 meeting it is probably answered by.
 */
const NOMINAL_HOUR = 9;

/** Tolerance for "that hour has not gone by"; nobody means 09:00 by 09:01. */
const GRACE_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

const DEFAULT_HORIZON_DAYS = 180;

/**
 * How far a clock time may sit from its date and still belong to it. Short enough
 * that a date paired with a time eighty lines down in a footer does not adopt it,
 * long enough for "mañana 03/10 salida 18:27", where the two are 12 characters apart.
 */
const NEAR_MS = 120;

/**
 * Short month names, only where a mail uses them: "15 nov", "Nov 15", "4 de sept".
 * "mar" (also martes), "may" and "ago" (English "2 days ago") only count after "de".
 */
const MONTH_ABBR: Record<string, number> = {
  ene: 1,
  jan: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  apr: 4,
  jun: 6,
  jul: 7,
  ago: 8,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  dec: 12,
};
const ABBR_NEEDS_DE = new Set(['mar', 'may', 'ago']);

function monthOf(token: string | undefined, afterDe: boolean): number {
  const name = token ?? '';
  const full = MONTHS[name];
  if (full !== undefined) return full;
  if (!afterDe && ABBR_NEEDS_DE.has(name)) return Number.NaN;
  return MONTH_ABBR[name] ?? Number.NaN;
}

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
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** Weekday name -> 0..6, Sunday first, to line up with `Date#getDay`. */
const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export type CommitmentKind = 'meeting' | 'travel' | 'payment' | 'deadline' | 'other';

export interface KindSignal {
  kind: CommitmentKind;
  marker: string;
}

/**
 * The strongest keyword wins, and THE ORDER IS THE POLICY: "your ticket expires
 * tomorrow" is a deadline before it is travel, and a flight confirmation that also
 * mentions an invoice is still a flight. One kind per mail on purpose - an email
 * naming two things yields one entry, because a mail that gets two guesses wrong is
 * noisier than one that gets a single guess right.
 */
const KIND_RULES: ReadonlyArray<{ kind: CommitmentKind; re: RegExp; marker: string }> = [
  {
    kind: 'travel',
    re: /\b(billete|billetes|reserva|reservado|booking|vuelo|flight|boarding|tren|train|renfe|ave|itinerario|check ?in|embarque|autobus|avion|hotel|alojamiento|viaje|ida y vuelta|localizador|seat|asiento)\b/,
    marker: 'travel',
  },
  {
    kind: 'payment',
    re: /\b(factura|invoice|vence|vencimiento|pago|pagar|cobro|cobrar|recibo|domiciliacion|domiciliado|cuota|deuda|payment|due date|abono|importe)\b/,
    marker: 'payment',
  },
  {
    kind: 'deadline',
    re: /\b(plazo|deadline|fecha limite|limite|caduca|caducidad|expira|expires|expiration|inscripcion|matricula|ultimo dia)\b/,
    marker: 'deadline',
  },
  {
    kind: 'meeting',
    re: /\b(cita|reunion|llamada|meeting|call|entrevista|videollamada|appointment|agenda|quedamos|nos vemos|te espero|conferencia|webinar|stand ?up|demo|sync)\b/,
    marker: 'meeting',
  },
];

/** The kind a text implies, for callers that only hold a title (a calendar event). */
export function classifyKind(text: string): CommitmentKind {
  const folded = withoutTimeOfDay(fold(text));
  for (const rule of KIND_RULES) if (rule.re.test(folded)) return rule.kind;
  return 'other';
}

interface YearMonthDay {
  year: number;
  month: number;
  day: number;
}

interface Context {
  now: number;
  timeZone: string;
}

/**
 * The calendar date an instant falls on, read in the user's zone.
 *
 * Neither `getUTCDate()` nor `getDate()` on a Date built from a local midnight: a
 * local midnight in Madrid is 22:00 UTC the day before, so both name yesterday -
 * an off-by-one that only appears east of Greenwich and is therefore invisible to
 * whoever writes the test in a UTC dev container.
 */
function ymd(at: number, timeZone: string): YearMonthDay {
  const parts = zonedParts(at, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Calendar-day arithmetic in the user's zone, so "en 3 dias" survives a DST change. */
function dayOffset(ctx: Context, days: number): YearMonthDay {
  return ymd(zonedAddDays(ctx.now, days, ctx.timeZone), ctx.timeZone);
}

function expandYear(value: number): number {
  if (value >= 1000) return value;
  // Two digits: the 70s are last century, the 30s this one. Anything else is a misparse.
  return value >= 70 ? 1900 + value : 2000 + value;
}

interface DateHit {
  /** Epoch ms in the user's zone, at `NOMINAL_HOUR` until a clock time is paired. */
  at: number;
  /** How firmly the date was pinned down, 0..100. See the rules below. */
  specificity: number;
  /** Character offset in the folded text, so a clock time can be paired with it. */
  index: number;
  /** Which pattern produced it. */
  rule: string;
}

/**
 * Every date the text can offer, best first.
 *
 * The array is ordered by specificity and `bestDate` stops at the first pattern that
 * produced a hit, so this ordering IS the priority. Within one specificity the tie is
 * deliberate: `pasado manana` before `manana`, because both sentences contain the word
 * "mañana" and reading it wrong loses a day.
 */
const DATE_RULES: ReadonlyArray<{
  re: RegExp;
  specificity: number;
  rule: string;
  build: (match: RegExpExecArray, ctx: Context) => DateHit | undefined;
}> = [
  {
    // ISO 8601: the only format with no reading to choose between.
    re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
    specificity: 100,
    rule: 'iso',
    build: (m, ctx) => calendarHit(Number(m[1]), Number(m[2]), Number(m[3]), ctx, m, 'iso', 100),
  },
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/,
    specificity: 95,
    rule: 'dd/mm/yyyy',
    build: (m, ctx) => slashHit(m, ctx, 95, 'dd/mm/yyyy'),
  },
  {
    // The year is four digits, or two that are not the start of a clock or a span:
    // "el 4 de noviembre de 10:00 a 12:00" is 10 o'clock, not the year 2010 (which
    // put the meeting in the past and dropped it).
    re: /\b(\d{1,2})(?:er|º|o)?( de |-| )([a-z]+?)\.?(?: de (\d{4}|\d{2}(?![:.,h\d]| ?(?:a|al|hasta|y)\b)))?\b/,
    specificity: 95,
    rule: 'dia de mes',
    build: (m, ctx) =>
      calendarHit(
        m[4] ? expandYear(Number(m[4])) : undefined,
        monthOf(m[3], m[2] === ' de '),
        Number(m[1]),
        ctx,
        m,
        'dia de mes',
        95,
      ),
  },
  {
    re: /\b(\d{1,2})[.-](\d{1,2})[.-](\d{2,4})\b/,
    specificity: 92,
    rule: 'dd-mm-yyyy',
    build: (m, ctx) => slashHit(m, ctx, 92, 'dd-mm-yyyy'),
  },
  {
    re: /\b([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? de (\d{4}))?\b/,
    specificity: 90,
    rule: 'mes dia',
    build: (m, ctx) =>
      calendarHit(
        m[3] ? expandYear(Number(m[3])) : undefined,
        monthOf(m[1], false),
        Number(m[2]),
        ctx,
        m,
        'mes dia',
        90,
      ),
  },
  {
    re: /\b(\d{1,2})\/(\d{1,2})\b/,
    specificity: 88,
    rule: 'dd/mm',
    build: (m, ctx) => slashHit(m, ctx, 88, 'dd/mm'),
  },
  {
    // "el día 5" with no month: the next 5th - this month if it has not gone by, else
    // the next month that has that day. With a month after it, 'dia de mes' reads it;
    // "el día 5 de cada mes" is a routine, not a date.
    re: /\b(?:el )?dia (\d{1,2})\b(?![:./h]\d| ?(?:de|del) [a-z])/,
    specificity: 70,
    rule: 'dia sin mes',
    build: (m, ctx) => nextDayOfMonth(Number(m[1]), ctx, m),
  },
  {
    // A weekday, with or without "el" / "next". "Next Monday" said on a Monday is a
    // week away, which is what the word means; a bare "el lunes" said on a Monday is
    // today, which is what that means.
    re: /\b(?:(proximo|proxima|next|este|esta)\s+)?(?:el |la |los |las )?(domingo|lunes|martes|miercoles|jueves|viernes|sabado|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
    specificity: 70,
    rule: 'dia de semana',
    build: (m, ctx) => {
      const target = WEEKDAYS[m[2] ?? ''];
      if (target === undefined) return undefined;
      // The weekday in the user's zone, not the host's: at 03:00 on a Saturday in
      // Madrid it is still Friday in New York, and "el lunes" is three days away there.
      const today = ymd(ctx.now, ctx.timeZone);
      const here = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      const delta = (target - here + 7) % 7;
      const forward = /proximo|proxima|next/.test(m[1] ?? '') && delta === 0 ? 7 : delta;
      return {
        at: zonedTime({ ...dayOffset(ctx, forward), hour: NOMINAL_HOUR }, ctx.timeZone),
        specificity: 70,
        index: m.index,
        rule: 'dia de semana',
      };
    },
  },
  {
    re: /\b(hoy|today)\b/,
    specificity: 65,
    rule: 'hoy',
    build: (m, ctx) => ({
      at: zonedTime({ ...ymd(ctx.now, ctx.timeZone), hour: NOMINAL_HOUR }, ctx.timeZone),
      specificity: 65,
      index: m.index,
      rule: 'hoy',
    }),
  },
  {
    re: /\bpasado manana\b/,
    specificity: 60,
    rule: 'pasado manana',
    build: (m, ctx) => relativeHit(m, ctx, 2, 'pasado manana', 60),
  },
  {
    re: /\btomorrow\b/,
    specificity: 60,
    rule: 'tomorrow',
    build: (m, ctx) => relativeHit(m, ctx, 1, 'tomorrow', 60),
  },
  {
    re: /\bmanana\b/,
    specificity: 60,
    rule: 'manana',
    build: (m, ctx) => relativeHit(m, ctx, 1, 'manana', 60),
  },
  {
    // The phrasing marketing, newsletters and bank notices share. Weak on purpose:
    // on its own "en 5 dias" cannot clear the confidence bar.
    re: /\b(?:dentro de|en|within|in) (\d{1,3}) (dias?|semanas?|days?|weeks?)\b/,
    specificity: 50,
    rule: 'en N dias',
    build: (m, ctx) => {
      const amount = Number(m[1]);
      if (!Number.isFinite(amount) || amount < 1 || amount > 400) return undefined;
      return relativeHit(
        m,
        ctx,
        amount * (/semana|week/.test(m[2] ?? '') ? 7 : 1),
        'en N dias',
        50,
      );
    },
  },
  {
    re: /\b(?:la |this |next )?semana que viene\b|\bproxima semana\b|\bnext week\b/,
    specificity: 45,
    rule: 'la semana que viene',
    build: (m, ctx) => relativeHit(m, ctx, 7, 'la semana que viene', 45),
  },
];

/** The next calendar day numbered `day` from today (today included), in the user's zone. */
function nextDayOfMonth(day: number, ctx: Context, match: RegExpExecArray): DateHit | undefined {
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const today = ymd(ctx.now, ctx.timeZone);
  for (let k = 0; k < 13; k++) {
    const month0 = today.month - 1 + k;
    const year = today.year + Math.floor(month0 / 12);
    const month = (month0 % 12) + 1;
    if (day > daysInMonth(year, month) || (k === 0 && day < today.day)) continue;
    const at = zonedTime({ year, month, day, hour: NOMINAL_HOUR }, ctx.timeZone);
    if (Number.isNaN(at)) return undefined;
    return { at, specificity: 70, index: match.index, rule: 'dia sin mes' };
  }
  return undefined;
}

function calendarHit(
  year: number | undefined,
  month: number,
  day: number,
  ctx: Context,
  match: RegExpExecArray,
  rule: string,
  specificity: number,
): DateHit | undefined {
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year ?? 2000, month)) return undefined;
  if (year === undefined) {
    // No year written: the occurrence nearest to now. "El 5 de enero" in a mail read on
    // 20 December is next January, not eleven months ago; "el 28 de diciembre" read on
    // 3 January is the one that just went by. Taking the current year blindly lost
    // every January appointment mentioned in December.
    const current = ymd(ctx.now, ctx.timeZone).year;
    let best: number | undefined;
    for (const candidate of [current - 1, current, current + 1]) {
      if (day > daysInMonth(candidate, month)) continue;
      const at = zonedTime({ year: candidate, month, day, hour: NOMINAL_HOUR }, ctx.timeZone);
      if (Number.isNaN(at)) continue;
      if (best === undefined || Math.abs(at - ctx.now) < Math.abs(best - ctx.now)) best = at;
    }
    return best === undefined ? undefined : { at: best, specificity, index: match.index, rule };
  }
  if (!Number.isInteger(year) || year < 1970 || year > 2200) return undefined;
  const at = zonedTime({ year, month, day, hour: NOMINAL_HOUR }, ctx.timeZone);
  if (Number.isNaN(at)) return undefined;
  return { at, specificity, index: match.index, rule };
}

/** 28..31 - "31 de febrero" is not a date, and must not roll over into 3 March. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `dd/mm`, `dd-mm`, with or without a year.
 *
 * Read day-first, the Spanish convention the user writes in. Where the two readings
 * genuinely diverge - both numbers 12 or under, so `03/10` is ambiguous - day-first
 * wins for the same reason. And a first number above 12, `13/03`, cannot be a day, so
 * the swap is automatic without anyone having to declare a locale.
 */
function slashHit(
  match: RegExpExecArray,
  ctx: Context,
  specificity: number,
  rule: string,
): DateHit | undefined {
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return undefined;
  let day = first;
  let month = second;
  // Day-first always; only a second number that cannot be a month (`03/13`) swaps.
  // The old test - first <= 12 and first > second - turned every unambiguous Spanish
  // date such as `10/03` (10 March) into 3 October.
  if (month > 12 && day <= 12) [day, month] = [month, day];
  const year = match[3] ? expandYear(Number(match[3])) : undefined;
  return calendarHit(year, month, day, ctx, match, rule, specificity);
}

function relativeHit(
  match: RegExpExecArray,
  ctx: Context,
  days: number,
  rule: string,
  specificity: number,
): DateHit {
  return {
    at: zonedTime({ ...dayOffset(ctx, days), hour: NOMINAL_HOUR }, ctx.timeZone),
    specificity,
    index: match.index,
    rule,
  };
}

/** The best date in the text, or nothing. Never a guess. */
function bestDate(folded: string, ctx: Context): DateHit | undefined {
  for (const entry of DATE_RULES) {
    const scanner = new RegExp(entry.re.source, 'gu');
    let best: DateHit | undefined;
    let match = scanner.exec(folded);
    while (match) {
      // A pattern can match and still build nothing - "13/40" is not a date - so the
      // scan carries on instead of abandoning the whole pattern.
      const hit = entry.build(match, ctx);
      if (hit && (!best || hit.specificity > best.specificity)) best = hit;
      match = scanner.exec(folded);
    }
    if (best) return best;
  }
  return undefined;
}

interface TimeHit {
  hour: number;
  minute: number;
  index: number;
  /** "Medianoche", "a las 12 de la noche": the clock belongs to the night after the date. */
  nextDay?: boolean;
}

/**
 * Clock times, in 24h. The 24h rule is tried first on purpose: a mail that writes both
 * "18:27" and "6pm" means 18:27, and the first reading of the text is the one that
 * carries the actual departure.
 */
const TIME_RULES: ReadonlyArray<{
  re: RegExp;
  build: (m: RegExpExecArray) => TimeHit | undefined;
}> = [
  {
    // "9:30h" and "18:00 hrs" are how Spanish mail writes a clock; the trailing letters
    // are part of it. 24:00-29:59 only come from spokenTimes() (or a mail that literally
    // says 24:00) and mean that hour of the night after the date.
    re: /\b(?:a las |a la |at |desde las |@)?(\d{1,2}):(\d{2})(?:h|hs|hrs)?\b/,
    build: (m) => {
      const hour = Number(m[1]);
      if (hour >= 24 && hour <= 29) {
        const hit = clock24(hour - 24, Number(m[2]));
        return hit && { ...hit, nextDay: true };
      }
      return clock24(hour, Number(m[2]));
    },
  },
  {
    // "17.30 h": a dot clock only counts with its hour mark, so "12.50 €" never does.
    re: /\b(\d{1,2})\.(\d{2}) ?(?:h|hs|hrs|horas)\b/,
    build: (m) => clock24(Number(m[1]), Number(m[2])),
  },
  {
    re: /\b(\d{1,2})\s*(am|pm)\b/,
    build: (m) => clock24((Number(m[1]) % 12) + (m[2] === 'pm' ? 12 : 0), 0),
  },
  {
    re: /\ba las (\d{1,2})\b/,
    build: (m) => {
      const hour = Number(m[1]);
      if (!Number.isInteger(hour) || hour < 1 || hour > 23) return undefined;
      // "A las 3" is 15:00 in a mail about a dinner, a flight or a call, and nobody
      // means 03:00. The low hours are read as afternoon; 8 and up is taken as
      // written, because "a las 9" means nine.
      return { hour: hour <= 7 ? hour + 12 : hour, minute: 0, index: m.index ?? 0 };
    },
  },
];

function clock24(hour: number, minute: number): TimeHit | undefined {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return { hour, minute, index: 0 };
}

function timesIn(folded: string): TimeHit[] {
  const hits: TimeHit[] = [];
  for (const rule of TIME_RULES) {
    const scanner = new RegExp(rule.re.source, 'gu');
    let match = scanner.exec(folded);
    while (match) {
      const hit = rule.build(match);
      if (hit) hits.push({ ...hit, index: match.index });
      match = scanner.exec(folded);
    }
  }
  return hits;
}

/**
 * The hour that belongs to THIS date, not merely the first one in the mail.
 *
 * "mañana 03/10 salida 18:27" puts the time twelve characters from the date, so it
 * belongs to it. "El viernes: recordatorio de que la factura vencia el 3" has no time
 * anywhere near its date, and the nominal anchor is the honest answer - borrowing an
 * unrelated time from a footer would put a meeting at midnight and print a precision
 * the user has no way to check.
 */
function timeNear(date: DateHit, folded: string): TimeHit | undefined {
  let best: TimeHit | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const time of timesIn(folded)) {
    const distance = Math.abs(time.index - date.index);
    if (distance > NEAR_MS || distance >= bestDistance) continue;
    best = time;
    bestDistance = distance;
  }
  return best;
}

const EXPIRY_STRONG_RE =
  /\b(caduca|caducara|caducan|caducidad|expira|expirara|expiran|expires|expiring|expiration|renueva|renovara|renovacion|renews|renewal)\b/;
const EXPIRY_VENCE_RE = /\b(vence|vencen|vencimiento)\b/;
const MONEY_DUE_RE =
  /(factura|invoice|recibo|pago|pagar|cuota|importe|cobro|payment|abono|\u20ac|\beur\b)/;

/**
 * Expiry = positive proof only. "caduca/expira/renueva" always count. "vence" counts only
 * when the mail carries no money word: "vence la factura" is a payment due, not an expiry.
 */
export function isExpiry(folded: string): boolean {
  if (EXPIRY_STRONG_RE.test(folded)) return true;
  return EXPIRY_VENCE_RE.test(folded) && !MONEY_DUE_RE.test(folded);
}

function kindIn(folded: string): KindSignal | undefined {
  for (const rule of KIND_RULES)
    if (rule.re.test(folded)) return { kind: rule.kind, marker: rule.marker };
  return undefined;
}

const NEWSLETTER_RE =
  /\b(newsletter|boletin|darse de baja|unsubscribe|unsubscrib|preferencias de suscripcion|click here|oferta|descuento|promocion|black friday|cupon|rebajas)\b/;
const AUTOMATED_SENDER_RE =
  /^(no-?reply|noreply|do-?not-?reply|postmaster|mailer-?daemon|notificaciones?|bounce)/i;
/** A span, not a day. "Entre el 3 y el 10" is how a courier says "soon". */
const RANGE_RE = /\b(entre el|entre la|entre \d|del \d{1,2} al|from \d{1,2} to|between \d{1,2})\b/;
/** Proof the mail is about a real thing: an amount, or a booking reference. */
const DETAIL_RE =
  /(?:\u20ac|\bEUR\b|\bUSD\b|\d+[.,]\d{2}\s?\u20ac)|\b(ref|referencia|localizador|booking|asiento|seat)\s*[:#]?\s*[a-z0-9-]{3,}/i;
/**
 * A route. Capitalised words on both sides of a dash or arrow and nothing else, so
 * "Billete confirmado. Madrid - Barcelona" yields "Madrid - Barcelona" rather than
 * the whole sentence from the start of the line.
 */
const ROUTE_RE =
  /\b(\p{Lu}[\p{L}'-]{1,20}(?: \p{Lu}[\p{L}'-]{1,20}){0,2})\s*(?:-|\u2013|\u2014|\u2192)\s*(\p{Lu}[\p{L}'-]{1,20}(?: \p{Lu}[\p{L}'-]{1,20}){0,2})\b/u;

/** "Re: ", "Fwd: ", "[Externo] ": prefixes that make a subject useless as a title. */
function cleanSubject(subject: string): string {
  let out = subject.trim();
  for (let pass = 0; pass < 3; pass++) {
    const stripped = out
      .replace(/^(?:re|rv|resp|fwd|fw)\s*[:>]\s*/i, '')
      .replace(/^\[[^\]]{1,20}\]\s*/, '');
    if (stripped === out) break;
    out = stripped;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 90);
}

interface Evidence {
  specificity: number;
  timed: boolean;
  kindFound: boolean;
  detail: boolean;
  automated: boolean;
  newsletter: boolean;
  isRange: boolean;
  bodyLength: number;
}

/**
 * How much to believe a candidate. The whole table lives in one function because a
 * confidence number nobody can explain is a number nobody should act on.
 *
 *   evidence   spelled-out date 0.62 - weekday 0.58 - relative or "hoy" 0.50
 *   +0.22      a clock time next to that date
 *   +0.15      a keyword that names the kind of thing (billete, factura, cita...)
 *   +0.05      a concrete detail: an amount, or a booking reference
 *   -0.15      the date is a range: "entre el 3 y el 10" is a week wide
 *   -0.10      an automated sender. A nudge, never a rejection: this is where real
 *              confirmations come from
 *   -0.20      a relative date in a long body: a campaign talking about itself
 *   -0.05      newsletter furniture (unsubscribe, cupon, oferta)
 */
function score(evidence: Evidence): number {
  let value = evidence.specificity >= 90 ? 0.62 : evidence.specificity >= 70 ? 0.58 : 0.5;
  if (evidence.timed) value += 0.22;
  if (evidence.kindFound) value += 0.15;
  if (evidence.detail) value += 0.05;
  if (evidence.isRange) value -= 0.15;
  if (evidence.automated) value -= 0.1;
  if (evidence.specificity < 70 && evidence.bodyLength > 400) value -= 0.2;
  if (evidence.newsletter) value -= 0.05;
  return Math.min(0.99, Math.max(0.05, Number(value.toFixed(2))));
}

/**
 * One line the user will recognise. Their own subject first - a subject is something
 * they wrote or recognised at the time - enriched with the route or the amount when
 * the body has them, because "Billete confirmado" on its own says nothing.
 */
function summarize(message: MailMessage, kind: CommitmentKind): string {
  const body = message.text ?? '';
  const firstLine = body
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0);
  let title = cleanSubject(message.subject ?? '') || (firstLine ?? '').slice(0, 80);
  if (!title.trim()) title = 'Compromiso sin asunto';
  if (kind === 'travel') {
    const route = ROUTE_RE.exec(body);
    if (route?.[1] && route[2]) title = `Viaje ${route[1].trim()} \u2192 ${route[2].trim()}`;
  }
  if (kind === 'payment' || kind === 'deadline') {
    const amount = /(\d+[.,]\d{2})\s?\u20ac/.exec(body);
    if (amount?.[1]) title = `${title} (${amount[1]} \u20ac)`;
  }
  return title.replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * Fold for MATCHING only. Accents go, case goes, and everything that is neither a
 * letter, a digit nor a date separator goes too, so one pattern covers both languages.
 */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}:/.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SPOKEN_TIME_RE =
  /\b(a las|a la|sobre las|hacia las|desde las) (\d{1,2})(?:[:.](\d{2})(?!\d)| y (media|cuarto)| menos (cuarto))?(?: ?(?:h|hs|hrs|horas)\b)?(?: (de la manana|de la madrugada|de la tarde|de la noche|del mediodia))?/g;

/**
 * Spoken Spanish clocks, rewritten as "a las HH:MM" before anything else reads the text.
 *
 * withoutTimeOfDay() removes "de la tarde/noche/mañana" so a liked morning coffee is not a
 * date, and that used to happen BEFORE the hour was read: "a las 10 de la noche" became
 * 10:00, "a las 7 de la mañana" became 19:00 (low hours are read as afternoon) and
 * "a las 9 y media" lost its half hour. "06.15" was read as "a las 6" = 18:00, and
 * "medianoche" was no time at all. Only clocks introduced by "a las" (or a qualifier)
 * are touched, so "12.50 €" is never a time.
 */
const SLOT_RE =
  /\b(?:de|desde|entre) (?:las )?(\d{1,2})(?:[:.](\d{2}))? (?:a|y|hasta) (?:las )?(\d{1,2})(?:[:.](\d{2}))?(?: ?(h|hs|hrs|horas)\b)?(?: (de la manana|de la madrugada|de la tarde|de la noche|del mediodia)\b)?(?! ?(?:personas|plazas|asistentes|invitados|participantes|alumnos|ninos|adultos|euros|eur|dolares|dias|semanas|meses|anos|minutos|min|segundos|kg|km|metros|m2|unidades|anos|por ?ciento|%|\.\d|[:/.,-]?\d))/g;

function spokenTimes(folded: string): string {
  // "esta tarde a las 5" is today at 17:00. Without this the sentence had no date at
  // all ("esta tarde" is not a day word) and the meeting never reached the agenda.
  const today = folded.replace(
    /\besta (manana|tarde|noche),? (a las|a la) (\d{1,2}(?:[:.]\d{2})?)\b/g,
    (_w, part: string, lead: string, clock: string) => `hoy ${lead} ${clock} de la ${part}`,
  );
  // "de 10 a 12", "de 16 a 18 h", "entre las 10 y las 12": a slot whose start is
  // the time of the meeting. Without this the date stayed untimed (and "de 10" next to
  // a month could be read as a year). Counted things are not hours: "de 10 a 12
  // personas" is left alone.
  const ranges = today.replace(
    SLOT_RE,
    (
      whole,
      h1: string,
      m1: string | undefined,
      h2: string,
      m2: string | undefined,
      mark: string | undefined,
      part: string | undefined,
    ) => {
      const start = Number(h1);
      const end = Number(h2);
      if (start > 23 || end > 24 || (end <= start && !part)) return whole;
      const minute = m1 ? `:${m1}` : '';
      const hasMark = mark || m2 ? ' h' : '';
      return `a las ${h1}${minute}${minute ? '' : hasMark}${part ? ` ${part}` : ''} hasta ${h2}`;
    },
  );
  const out = ranges.replace(
    SPOKEN_TIME_RE,
    (whole, lead: string, h: string, mm?: string, half?: string, less?: string, part?: string) => {
      let hour = Number(h);
      let minute = mm !== undefined ? Number(mm) : 0;
      if (half === 'media') minute = 30;
      else if (half === 'cuarto') minute = 15;
      else if (less) {
        hour -= 1;
        minute = 45;
      }
      if (hour < 0 || hour > 23 || minute > 59) return whole;
      const explicit = mm !== undefined || /h|hs|hrs|horas/.test(whole.slice(lead.length));
      if (part === 'de la manana' || part === 'de la madrugada') {
        if (hour === 12) hour = 0;
      } else if (part === 'de la tarde' || part === 'del mediodia') {
        if (hour >= 1 && hour < 12) hour += 12;
      } else if (part === 'de la noche') {
        if (hour === 12 || hour === 0) hour = 24;
        else if (hour <= 4) hour += 24;
        else if (hour < 12) hour += 12;
      } else if (explicit) {
        // "a las 06.15", "a las 7h": a written clock is taken as written.
      } else if (half || less) {
        // Same reading as a bare "a las 3": low hours are afternoon.
        if (hour >= 1 && hour <= 7) hour += 12;
      } else {
        return whole;
      }
      return `a las ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    },
  );
  return out.replace(/\b(?:a (?:la )?)?medianoche\b/g, 'a las 24:00');
}

/**
 * "Por la mañana" is when someone likes something, never when it is due. Cut before
 * the date patterns run, or every sentence about a morning coffee becomes a
 * commitment for tomorrow - the same trap `src/cli.ts` guards against for follow-ups.
 */
function withoutTimeOfDay(folded: string): string {
  return folded.replace(
    // "esta mañana" is this morning, and read as "mañana" it became TOMORROW: "esta
    // mañana te mandé la factura" put a commitment on the next day. With a clock after
    // it, spokenTimes() has already turned it into "hoy a las ...".
    /\b(?:(?:por|en|a|de|esta) la (?:manana|tarde|noche|morning|afternoon|evening)|esta (?:manana|tarde|noche))\b/g,
    (phrase: string) => {
      // "por la tarde" is still not a date, but next to one it says when that day:
      // leave a marker no date or kind pattern reads (see partOfDayHour()).
      const part = /^(?:por|en|a|de) la (manana|tarde|noche)$/.exec(phrase)?.[1];
      return part ? ` ${PART_OF_DAY_MARK}${part} ` : ' ';
    },
  );
}

const PART_OF_DAY_MARK = 'pdxfranja';
const PART_OF_DAY_RE = new RegExp(`\\b${PART_OF_DAY_MARK}(manana|tarde|noche)\\b`, 'g');
/**
 * Nominal hours for "el sábado por la tarde": still `timed: false` (no clock was given),
 * but a reminder for Saturday afternoon must not fire at 09:00 on Saturday morning.
 */
const PART_OF_DAY_HOUR: Record<string, number> = { manana: NOMINAL_HOUR, tarde: 16, noche: 21 };
/** "el sábado por la tarde" / "por la tarde del sábado": a few words, not a paragraph. */
const PART_OF_DAY_NEAR = 30;

function partOfDayHour(date: DateHit, folded: string): number | undefined {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const m of folded.matchAll(PART_OF_DAY_RE)) {
    const distance = Math.abs((m.index ?? 0) - date.index);
    if (distance > PART_OF_DAY_NEAR || distance >= bestDistance) continue;
    best = PART_OF_DAY_HOUR[m[1] ?? ''];
    bestDistance = distance;
  }
  return best;
}

function nominalAt(date: DateHit, folded: string, timeZone: string): number {
  const hour = partOfDayHour(date, folded);
  if (hour === undefined || hour === NOMINAL_HOUR) return date.at;
  return zonedTime({ ...ymd(date.at, timeZone), hour, minute: 0 }, timeZone);
}

/**
 * Commitments worth telling the user about, soonest first.
 *
 * Pure: the same messages and the same `now` give the same array. Nothing here reads
 * the clock, the network or the filesystem, which is what makes it testable without a
 * mailbox and cheap enough to run on every turn.
 */
export function extractCommitments(
  messages: readonly MailMessage[],
  opts: ExtractOptions = {},
): ExtractedCommitment[] {
  const now = opts.now ?? Date.now();
  const timeZone = opts.timeZone ?? localTimeZone();
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE;
  const horizon = now + (opts.horizonDays ?? DEFAULT_HORIZON_DAYS) * DAY_MS;
  const ctx: Context = { now, timeZone };
  const found: ExtractedCommitment[] = [];

  for (const message of messages) {
    const raw = `${message.subject ?? ''} ${message.text ?? ''}`;
    const folded = withoutTimeOfDay(spokenTimes(fold(raw)));
    if (!folded) continue;

    // Filter 1: no date, no commitment. This one rule is what keeps "tu pedido ha sido
    // enviado" - the archetypal false positive - out of the agenda.
    const date = bestDate(folded, ctx);
    if (!date) continue;

    const signal = kindIn(folded);
    const expiry = isExpiry(folded);
    const time = timeNear(date, folded);
    const timed = time !== undefined;
    const at = timed
      ? zonedTime(
          {
            ...ymd(time.nextDay ? date.at + DAY_MS : date.at, timeZone),
            hour: time.hour,
            minute: time.minute,
          },
          timeZone,
        )
      : nominalAt(date, folded, timeZone);

    // Filter 2: the past is not pending. An untimed date is compared as a DAY, because
    // "hoy" written at 14:00 is still today even though the 09:00 anchor is behind us.
    const past = timed
      ? at < now - GRACE_MS
      : zonedDayKey(at, timeZone) < zonedDayKey(now, timeZone);
    if (past || !Number.isFinite(at) || at < 0 || at > horizon) continue;

    // Filter 3: a span is not a date. The matcher resolves "entre el 3 y el 10" to the
    // later end, which is the right end to look at, but it is still not a commitment.
    const isRange = RANGE_RE.test(folded.slice(Math.max(0, date.index - 40), date.index + 12));

    const confidence = score({
      specificity: date.specificity,
      timed,
      kindFound: signal !== undefined || expiry,
      detail: DETAIL_RE.test(raw),
      automated: AUTOMATED_SENDER_RE.test(message.from ?? ''),
      newsletter: NEWSLETTER_RE.test(folded),
      isRange,
      bodyLength: raw.length,
    });
    if (confidence < minConfidence) continue;

    found.push({
      subject: summarize(message, signal?.kind ?? (expiry ? 'deadline' : 'other')),
      at,
      kind: signal?.kind ?? (expiry ? 'deadline' : 'other'),
      confidence,
      source: { messageId: message.id, from: message.from ?? '' },
      timed,
      ...(expiry ? { expiry: true } : {}),
      because: [
        date.rule,
        signal?.marker,
        expiry ? 'caducidad' : null,
        timed ? 'hora' : 'sin hora',
        isRange ? 'rango' : null,
      ]
        .filter((part): part is string => typeof part === 'string')
        .join(' + '),
    });
  }

  found.sort((a, b) => a.at - b.at || a.subject.localeCompare(b.subject));
  return found;
}
