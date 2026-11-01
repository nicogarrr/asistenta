/**
 * The calendar, reduced to plain data an agenda can sort.
 *
 * WHY this layer exists: `src/tools/calendar.ts` owns a real iCalendar parser
 * (node-ical, VTIMEZONE resolution, RRULE expansion, folded lines, salvage of a
 * document one bad VEVENT would otherwise destroy). None of that is reimplemented
 * here on purpose - the second ICS parser in a codebase is the one that quietly
 * disagrees with the first, and a 09:00 meeting that shows up at 11:00 is exactly
 * the bug that makes an agenda untrustworthy. What was missing is not parsing but
 * shape: the tool returns `Date` objects and model-facing prose, while "what do I
 * have today" needs milliseconds it can sort, merge and group.
 *
 * TIMEZONES. All three RFC 5545 cases are honoured by delegating to `parseIcs`,
 * which is where they are actually implemented and tested:
 *   - `DTSTART:...Z`      -> absolute instant, identical on every machine.
 *   - `DTSTART;TZID=..`  -> wall time in a named zone, resolved against the IANA
 *                           database, so it does not depend on the host clock.
 *   - floating values     -> host-local, the reading RFC 5545 §3.3.5 defers to the
 *                           observer, and the one any calendar client will agree on.
 * What this file adds is the *window*: "today" is a day boundary in the user's own
 * zone (via `localTimeZone()` from src/datecontext.ts), never in UTC. Getting that
 * wrong is what makes a 00:30 UTC event land on the wrong day in the listing.
 *
 * ALL-DAY EVENTS. RFC 5545 makes DTEND exclusive and a `VALUE=DATE` DTEND a bare
 * date, so "the 5th to the 7th" arrives as start=midnight 5th, end=midnight 7th.
 * Rendered as a clock range that is `00:00-00:00` on every day it covers, i.e. an
 * event that appears to have no duration at all. `allDay` survives the translation
 * so the renderer can say "todo el día", and a degenerate end is widened to one
 * day instead of being reported as a zero-length slot.
 *
 * FAILURE IS A RETURN VALUE, NOT A THROW. A missing or stale iCal address is a
 * setup state the user has to fix, not a crash of "what do I have today": the other
 * two sources (mail, follow-ups) are still worth answering. So every failure comes
 * back as `{ events: [], reason }` and the caller decides what to do with the rest.
 */

import { localTimeZone } from '../datecontext.js';
import { log } from '../log.js';
import { DEFAULT_AGENDA_DAYS, MAX_AGENDA_DAYS, parseIcs } from '../tools/calendar.js';
import { type CalendarSources, loadCalendarSources, mergeCalendarEvents } from './sources.js';

const DAY_MS = 86_400_000;

/** An event, as the agenda needs it: numbers it can sort, not `Date` it cannot. */
export interface AgendaEvent {
  id: string;
  title: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms, exclusive for an all-day event. */
  end: number;
  allDay: boolean;
  location?: string;
  source: 'calendar';
}

export interface UpcomingOptions extends CalendarSources {
  fetchText: (url: string) => Promise<string>;
  getUrl: () => Promise<string | undefined>;
  now?: () => number;
  days?: number;
  /**
   * The zone "today" is a day boundary in. Defaults to `localTimeZone()`, which
   * honours `PA_TIMEZONE` before falling back to the host zone - the same answer
   * `src/datecontext.ts` gives the model when it is told what today is.
   */
  timeZone?: string;
}

/**
 * Why the calendar contributed nothing, in Spanish, ready to show the user.
 * `configured: false` means "there is nothing to fix here", it is not an error.
 */
export interface CalendarSnapshot {
  events: AgendaEvent[];
  configured: boolean;
  reason?: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * THE TIMEZONE PRIMITIVES BELOW - `zonedParts`, `zonedDayKey`, `zonedDayStart`,
 * `zonedTime` - are the single answer this module gives to "what day and what hour
 * is this instant in the user's zone". They are exported instead of private because
 * `extract.ts` and `unified.ts` need the identical arithmetic. Three copies of
 * local-midnight math is three chances for "today" to be a different day in a
 * different list, which is a bug the user only notices as a missing appointment.
 */

/**
 * The wall clock in `timeZone`.
 *
 * `formatToParts` rather than `toLocaleString`: the parts are needed as numbers, and
 * a localised string would have to be parsed back out of whatever the ICU build
 * decided the separator is. `h23` matters as much - `hour12` would hand back 24 for
 * midnight, which is the previous day to every date calculation below.
 */
export function zonedParts(at: number, timeZone: string = localTimeZone()): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const read = (type: string): number => {
    const found = fmt.formatToParts(new Date(at)).find((part) => part.type === type);
    const value = Number(found?.value);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/** `YYYY-MM-DD` in the user's zone. The identity of a day, wherever it was born. */
export function zonedDayKey(at: number, timeZone?: string): string {
  const p = zonedParts(at, timeZone ?? localTimeZone());
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** How far the zone's wall clock runs ahead of UTC at that instant. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  // Second-truncated so the subtraction is an exact multiple of a minute: leaving
  // seconds in would fold an 18:27:43 event into a 18:28 offset and drift a day.
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  return wallAsUtc - Math.floor(at / 60_000) * 60_000;
}

/**
 * Local midnight of the day `at` falls in, as epoch ms.
 *
 * Two passes because the offset is needed to find the midnight and the offset at
 * that midnight can be the other one on a DST boundary day. One pass is off by an
 * hour exactly twice a year, and an agenda that is off by an hour on the two days
 * the clocks change is off on the days people travel.
 */
export function zonedDayStart(at: number, timeZone: string = localTimeZone()): number {
  const p = zonedParts(at, timeZone);
  return zonedMidnight(p.year, p.month, p.day, timeZone);
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  // Date.UTC normalises an out-of-range day (31 + 1 is the 1st of the next month).
  const wallAsUtc = Date.UTC(year, month - 1, day);
  return wallAsUtc - zoneOffsetMs(wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone), timeZone);
}

/**
 * Local midnight of the calendar day `days` after the day `at` falls in.
 *
 * Not `zonedDayStart(dayStart + days * 24 h)`: on the Sunday the clocks go back the
 * day has 25 hours, so midnight + 24 h is 23:00 of the SAME day and "mañana" came
 * out as today - the agenda's "Hoy" was empty and today's meetings were printed
 * under "Mañana", and a 7-day window stopped a day short. Walking the calendar date
 * instead is exact on both DST days.
 */
export function zonedAddDays(at: number, days: number, timeZone: string = localTimeZone()): number {
  const p = zonedParts(at, timeZone);
  return zonedMidnight(p.year, p.month, p.day + days, timeZone);
}

/**
 * The inverse: a wall clock reading in `timeZone` as an epoch.
 *
 * This lives next to the other timezone primitives because `src/agenda/extract.ts`
 * needs it to turn "mañana 18:27" into an instant, and two implementations of
 * "local time to epoch" is how an event ends up an hour off twice a year. Text like
 * a date is always in the user's own zone: an email written in Madrid that says
 * 18:27 means 18:27 in Madrid, whatever the agent happens to be running on.
 *
 * A reading that does not exist (02:30 on a spring-forward morning) resolves to the
 * offset in force before the jump, so the result is always a real instant.
 */
export function zonedTime(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string = localTimeZone(),
): number {
  const hour = parts.hour ?? 9;
  const minute = parts.minute ?? 0;
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0);
  const first = wall - zoneOffsetMs(wall, timeZone);
  const second = wall - zoneOffsetMs(first, timeZone);
  const back = zonedParts(second, timeZone);
  return back.hour === hour && back.minute === minute ? second : first;
}

function clampDays(days: number | undefined): number {
  const requested = Math.round(Number(days ?? DEFAULT_AGENDA_DAYS));
  if (!Number.isFinite(requested)) return DEFAULT_AGENDA_DAYS;
  return Math.min(Math.max(1, requested), MAX_AGENDA_DAYS);
}

/**
 * The address is a read-only password over the whole calendar, so it is stripped out
 * of anything that could reach a log, a chat line or the model. The tool file keeps
 * its own copy of this rule because its copy is the one with an error path that
 * quotes the fetcher's message verbatim.
 */
function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}

function failureMessage(err: unknown, secret: string): string {
  const detail = err instanceof Error ? err.message : String(err);
  const status = /\b([45]\d\d)\b/.exec(detail)?.[1];
  if (status)
    return `No se ha podido leer el calendario: el calendario respondió ${status} (dirección iCal caducada o reiniciada)`;
  // The raw error (redacted) is for the log; /agenda and the briefing get a plain line.
  log.warn('agenda: remote calendar unreachable', { err: redactSecret(detail, secret) });
  return 'No se ha podido leer el calendario: no hay conexión o no responde.';
}

/** `parseIcs` shape -> agenda shape, including the all-day fix. */
function toAgendaEvent(event: {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
}): AgendaEvent {
  const start = event.start.getTime();
  let end = event.end.getTime();
  // An all-day event whose DTEND is missing or equal to DTSTART would render as
  // 00:00-00:00. One whole day is the smallest truthful span for "all day".
  if (event.allDay && end <= start) end = start + DAY_MS;
  return {
    id: event.id,
    title: event.summary,
    start,
    end,
    allDay: event.allDay,
    ...(event.location ? { location: event.location } : {}),
    source: 'calendar',
  };
}

/**
 * Calendar events for today and the next `days` days, with the reason when there are
 * none. Never throws: a dead calendar degrades the agenda, it does not end the turn.
 */
export async function loadCalendar(opts: UpcomingOptions): Promise<CalendarSnapshot> {
  const now = (opts.now ?? Date.now)();
  const days = clampDays(opts.days);
  const timeZone = opts.timeZone ?? localTimeZone();

  const source = await loadCalendarSources(opts);
  const reasons: string[] = [];
  if (source.localError) reasons.push(source.localError);
  if (source.googleError) reasons.push(source.googleError);
  if (source.invalidUrl)
    reasons.push('La dirección del calendario no es una URL http(s) válida; revisa la bóveda.');
  if (source.remoteError) reasons.push(failureMessage(source.remoteError, source.url ?? ''));
  if (!source.local && !source.remote && !source.google && !reasons.length) {
    reasons.push('No hay calendario configurado todavía (falta la dirección iCal en la bóveda).');
  }
  if (
    reasons.length &&
    (source.remoteError || source.invalidUrl || source.localError || source.googleError)
  ) {
    log.warn('agenda: calendar unavailable', { reason: reasons.join(' ') });
  }
  const parsed = mergeCalendarEvents(source.local ? parseIcs(source.local, new Date(now)) : [], [
    ...(source.remote ? parseIcs(source.remote, new Date(now)) : []),
    ...(source.google ? parseIcs(source.google, new Date(now)) : []),
  ]);
  const from = zonedDayStart(now, timeZone);
  // Local midnight `days` calendar days from now, walked by date so a DST change
  // inside the window cannot shift the last day.
  const horizon = zonedAddDays(now, days, timeZone);

  const events = parsed
    .map(toAgendaEvent)
    // An event still running at midnight stays in "today"; one that started before
    // the window and ran into it belongs to the day it started on.
    .filter(
      (event) =>
        event.start < horizon &&
        (event.end > Math.max(now, from) || (event.start === event.end && event.start >= now)),
    );

  events.sort((a, b) => a.start - b.start || a.end - b.end);
  log.info('agenda: calendar', { days, events: events.length });

  return {
    events,
    configured: Boolean(source.local || source.url),
    ...(reasons.length ? { reason: reasons.join(' ') } : {}),
  };
}

/**
 * Just the events. The narrow form of `loadCalendar` for callers that have no reason
 * to surface; identical events, identical window.
 */
export async function upcomingEvents(opts: UpcomingOptions): Promise<AgendaEvent[]> {
  return (await loadCalendar(opts)).events;
}
