import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { CalendarResponse, EventInstance, VEvent } from 'node-ical';
// node-ical ships a real ESM entry point (`exports.import` -> node-ical.js) with
// both named exports and a default namespace object, and its typings are an
// ambient `declare module 'node-ical'`. Under NodeNext + verbatimModuleSyntax the
// named imports and `import type` both resolve against that ambient declaration,
// so there is no default-import interop shim and no `require` path in play.
import { expandRecurringEvent, parseICS } from 'node-ical';
import { Type } from 'typebox';
import {
  type CalendarSources,
  loadCalendarSources,
  mergeCalendarEvents,
} from '../agenda/sources.js';
import { log } from '../log.js';

/**
 * Calendar agenda from the secret iCal address.
 *
 * The only genuinely zero-setup calendar integration that exists. Google Calendar
 * publishes a per-calendar URL ending in `/basic.ics` (Calendar settings ->
 * Integrate calendar -> "Secret address in iCal format"). Fetching it needs no
 * OAuth app, no client id, no consent screen, no API key and no card, which is the
 * entire reason this tool exists rather than the Google Calendar API.
 *
 * Two limits are load-bearing and must reach the model in the tool description:
 *
 * 1. READ-ONLY. There is no write path through an iCal feed, by design. The agent
 *    can look, never touch.
 * 2. STALE. Google regenerates the feed lazily and clients poll it every 30-60
 *    minutes, so the feed can lag reality by up to ~24h. Good enough for "what is
 *    coming up", worthless for "remind me in ten minutes".
 *
 * The URL IS the credential. Anyone holding it can read every event on that
 * calendar including private ones, which is why it lives in the vault and why it
 * must never appear in a log line, an error message or a tool result that gets
 * echoed back to the model or into a chat transcript.
 */

const DAY_MS = 86_400_000;

/** Ceiling for both the `days` argument and `parseIcs`' expansion window. */
export const MAX_AGENDA_DAYS = 60;

export const DEFAULT_AGENDA_DAYS = 7;

/** Vault key the address is stored under. The wiring in cli.ts must use this. */
export const ICS_URL_KEY = 'calendar:icsUrl';

export const CALENDAR_TOOL_NAME = 'calendar';

/**
 * Reserving room for the truncation notice keeps the promise that the total stays
 * within `maxChars`; the longest possible notice is well under this.
 */
const NOTICE_RESERVE = 64;

export interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  busy?: boolean;
}

/**
 * node-ical hands back `string | {val, params}` for any property that carried
 * parameters (`SUMMARY;LANGUAGE=es:...` is the common case), so every text field
 * has to be unwrapped before it can be compared or rendered.
 */
function plain(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'val' in value) {
    const inner = (value as { val?: unknown }).val;
    return typeof inner === 'string' ? inner : undefined;
  }
  return undefined;
}

/**
 * Clip a text field to a sane length. Deliberately does NOT collapse whitespace:
 * an escaped `\n` in a DESCRIPTION is real structure that came out of the feed, and
 * flattening it here would lose data the caller may want. Collapsing belongs to the
 * renderer, which is where one-line-per-event is a requirement.
 */
function clip(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * All grouping and rendering is done with local getters and hand-rolled names
 * rather than `Intl.DateTimeFormat`, for two reasons: the local zone is already
 * the zone the listing reports in, and hand-rolled formatting cannot be moved by
 * an ICU version's midnight convention ("24:00" vs "00:00").
 */
function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local time';
}

function offsetLabel(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

function dayHeader(at: Date): string {
  const weekday = WEEKDAYS[at.getDay()] ?? '???';
  const month = MONTHS[at.getMonth()] ?? '???';
  return `${weekday} ${at.getDate()} ${month} ${at.getFullYear()}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function localDayCount(start: Date, end: Date): number {
  const from = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  // RFC 5545 DTEND is exclusive, so the last covered day is the day before it. Stepping
  // back a whole day (rather than a millisecond) is what keeps a five-to-seven March
  // span at two days instead of rounding up to three.
  const to = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  return Math.max(1, Math.round((to - from) / DAY_MS) + 1);
}

/** Feeds put newlines inside SUMMARY/LOCATION/DESCRIPTION; the listing cannot. */
function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function renderEvent(event: CalendarEvent): string {
  const time = event.allDay
    ? (() => {
        const days = localDayCount(event.start, event.end);
        return days > 1 ? `all day (${days} days)` : 'all day';
      })()
    : (() => {
        const range = `${pad2(event.start.getHours())}:${pad2(event.start.getMinutes())}-${pad2(
          event.end.getHours(),
        )}:${pad2(event.end.getMinutes())}`;
        // A timed event that runs past midnight would otherwise print "23:00-01:00"
        // with nothing to say that the end is on the following day.
        const overnight = isSameDay(event.start, event.end) ? '' : ' (+1d)';
        return `${range} ${offsetLabel(event.start)}${overnight}`;
      })();

  const where = event.location ? `  · ${flatten(event.location)}` : '';
  // TRANSP:TRANSPARENT is the only thing that makes an event "free" in iCalendar,
  // and it is worth surfacing: a lunch marked free is not a busy hour.
  const free = event.busy === false ? '  · free' : '';
  const lines = [`  ${time}  ${flatten(event.summary)}${where}${free}`];
  if (event.description) lines.push(`      ${flatten(event.description)}`);
  return lines.join('\n');
}

/**
 * Expand one VEVENT into the instances that fall inside the window.
 *
 * The per-event try/catch is not defensive decoration: rrule-temporal enforces its
 * own 10,000-iteration ceiling and throws `Maximum iterations (10000) exceeded`
 * for any rule too dense to enumerate, so a single malformed or absurd series
 * would otherwise abort the whole feed and lose every other event with it.
 */
function expandInstances(event: VEvent, from: Date, to: Date): EventInstance[] {
  try {
    return expandRecurringEvent(event, { from, to, expandOngoing: true });
  } catch {
    return [];
  }
}

/**
 * Re-parse a feed one VEVENT at a time, for the feeds node-ical rejects whole.
 *
 * A single duplicated DTSTART aborts `parseICS` for the entire document, which
 * would turn one malformed event into an empty agenda. The preamble before the
 * first VEVENT is re-attached to each event because it carries the VTIMEZONE
 * blocks, and a floating DTSTART resolves against whichever one is in scope:
 * dropping it would silently move those events into the host timezone.
 */
function salvageResponses(text: string): CalendarResponse[] {
  const responses: CalendarResponse[] = [];
  const parts = text.split(/^BEGIN:VEVENT/m);
  const preamble = parts[0] ?? '';
  for (const part of parts.slice(1)) {
    const close = part.search(/^END:VEVENT/m);
    const event = close === -1 ? part : part.slice(0, close + 'END:VEVENT'.length);
    try {
      responses.push(parseICS(`${preamble}BEGIN:VEVENT${event}\nEND:VCALENDAR`));
    } catch {
      // This one event is beyond repair; the rest of the feed is still worth having.
    }
  }
  return responses;
}

/**
 * Parse raw `.ics` text into agenda events, sorted by start time.
 *
 * Pure: same text plus same `now` gives the same array, and nothing here touches
 * the network, the clock (unless `now` is omitted), or the filesystem.
 *
 * TIMEZONES. Three cases, in descending order of trustworthiness:
 *
 * - `DTSTART:...Z` is an absolute instant. node-ical builds it with `Date.UTC`, so
 *   it is correct on any machine.
 * - `DTSTART;TZID=Europe/Madrid:...` is a wall time in a named zone. node-ical
 *   resolves the TZID against the runtime's IANA database (and falls back to a
 *   fixed offset for `+01:00`-style labels), so it is also machine-independent.
 * - A FLOATING value, with neither `Z` nor `TZID`, is per RFC 5545 §3.3.5 in
 *   "the local time of the observer" - which is to say the spec deliberately
 *   refuses to say. This agent interprets it in the host's timezone (Node's `TZ`),
 *   which is the same reading the user's own calendar client will apply and the
 *   only one available without another config knob. Consequence, stated plainly:
 *   `parseIcs` is machine-dependent for floating values ONLY; `Z` and `TZID` events
 *   carry the same instant everywhere. The one exception to the host-local reading
 *   is a feed that ships a VTIMEZONE block: node-ical then borrows that block's
 *   zone for floating values, which is what feeds like the WordPress events
 *   calendar rely on.
 *
 * Everything is compared against `now`, and events that have already finished are
 * dropped (`expandOngoing` keeps the ones still running, which is what you want for
 * "what am I in the middle of").
 *
 * `end` is the raw RFC 5545 boundary, so for an all-day event it is the EXCLUSIVE
 * end: local midnight at the start of the following day.
 */
export function parseIcs(text: string, now: Date = new Date()): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const to = new Date(now.getTime() + MAX_AGENDA_DAYS * DAY_MS);

  let responses: CalendarResponse[];
  try {
    responses = [parseICS(text)];
  } catch {
    responses = salvageResponses(text);
  }

  for (const data of responses) {
    for (const component of Object.values(data)) {
      if (!component || component.type !== 'VEVENT') continue;
      const event = component;
      if (!(event.start instanceof Date) || Number.isNaN(event.start.getTime())) continue;

      for (const instance of expandInstances(event, now, to)) {
        const { start, end } = instance;
        if (!(start instanceof Date) || Number.isNaN(start.getTime())) continue;
        if (!(end instanceof Date) || Number.isNaN(end.getTime())) continue;

        // An override (RECURRENCE-ID) carries its own copy of the properties it
        // changed; everything it left alone still lives on the base event.
        const source = instance.event;
        const uid = plain(event.uid) ?? 'unknown';
        const location = clip(plain(source.location) ?? plain(event.location), 80);
        const description = clip(plain(source.description) ?? plain(event.description), 120);

        events.push({
          // A recurring series shares one UID across every instance, so the instance
          // start is what makes the id addressable.
          id: instance.isRecurring ? `${uid}@${start.toISOString()}` : uid,
          summary: clip(plain(source.summary) ?? plain(event.summary), 160) ?? '(no title)',
          start,
          end,
          allDay: instance.isFullDay,
          ...(location ? { location } : {}),
          ...(description ? { description } : {}),
          // TRANSP absent means OPAQUE per RFC 5545 §3.8.2.4, i.e. busy.
          busy: (source.transparency ?? event.transparency) !== 'TRANSPARENT',
        });
      }
    }
  }

  events.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  return events;
}

/**
 * Render an agenda as compact text for the model: grouped by day, one line per
 * event, offset on every timed line so "09:00" can never be read as some other
 * clock (a window that straddles a DST change would otherwise be wrong for half of
 * its own entries).
 *
 * `maxChars` is a budget, not a promise to drop silently: whatever does not fit is
 * counted and named in a trailing "and N more" line, so the model can say "and
 * there are more I did not show" instead of quietly reporting an empty Tuesday.
 */
export function summarizeForModel(events: CalendarEvent[], opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? 4000;
  if (events.length === 0) return 'No events in this window.';

  const ordered = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  const anchor = ordered[0]?.start ?? new Date();
  const header = `Agenda: ${ordered.length} event(s). Times are local to ${localZone()} (UTC${offsetLabel(
    anchor,
  )}).`;

  const budget = Math.max(0, maxChars - header.length - 1 - NOTICE_RESERVE);
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  let openDay = '';

  for (const event of ordered) {
    const day = dayHeader(event.start);
    // Cut on an event boundary, never mid-line, so the listing stays parseable.
    const block = (day === openDay ? '' : `${day}\n`) + renderEvent(event);
    if (used + block.length + 1 > budget) break;
    blocks.push(block);
    used += block.length + 1;
    shown += 1;
    openDay = day;
  }

  const dropped = ordered.length - shown;
  const body = blocks.join('\n');
  if (dropped <= 0) return `${header}\n${body}`;
  return `${header}\n${body}\n…and ${dropped} more not shown; ask for fewer days.`;
}

const MISSING_URL_TEXT = [
  'I cannot read a calendar yet: there is no iCal address in the vault.',
  '',
  'Set-up, about a minute, and free: no OAuth app, no API key, no card.',
  '1. In Google Calendar, open Settings, then the calendar you want, then',
  '   "Integrate calendar".',
  '2. Copy the "Secret address in iCal format" URL (it ends in /basic.ics).',
  `3. Then add your secret iCal address to the vault under the key ${ICS_URL_KEY}.`,
  '',
  `That URL is a password, not a link: anyone who has it can read every event on the calendar, including the private ones. Keep it out of chat messages and out of your replies. The stored address is never printed or logged by this tool.`,
].join('\n');

/** HTTP status carried by a thrown fetch error, if there is one. */
function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown };
    for (const candidate of [record.status, record.statusCode]) {
      if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
    }
  }
  // Injected fetchers surface the status in the message (the fetch tool does:
  // "404 Not Found for <url>"). It is the only signal available if the injected
  // implementation throws a bare Error.
  const match = /\b([45]\d\d)\b/.exec(err instanceof Error ? err.message : String(err ?? ''));
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * The address is a credential, so it is stripped out of anything the model or a
 * log file could end up holding, on top of never being put there in the first
 * place.
 */
function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}

function fetchFailureMessage(err: unknown, secret: string): string {
  const status = httpStatus(err);

  // Google answers 404 or 401 for a secret address that was reset (the address is
  // rotated every time the "Secret address" button is pressed) or belongs to a
  // calendar the current account can no longer read. That is a one-line fix, so it
  // gets its own message instead of being buried in a generic fetch failure.
  if (status === 401 || status === 403 || status === 404) {
    return [
      `The calendar feed answered ${status}.`,
      'That almost always means the stored secret iCal address is wrong or was reset:',
      'Google rotates it every time the "Secret address in iCal format" button is',
      `pressed, so open the calendar again and replace the ${ICS_URL_KEY} entry in the`,
      'vault with the current URL. (It is not printed here on purpose - that URL is a',
      'password that grants read access to every event on the calendar, private ones',
      'included.)',
    ].join(' ');
  }

  const detail = err instanceof Error ? err.message : String(err);
  return `Could not read the calendar feed${status ? ` (HTTP ${status})` : ''}: ${redactSecret(
    detail,
    secret,
  )}`;
}

const CalendarParams = Type.Object({
  action: Type.Union([Type.Literal('agenda')], {
    description: 'Only "agenda" exists: this tool cannot change anything.',
  }),
  days: Type.Optional(
    Type.Number({
      description: `How many days ahead to look. Default ${DEFAULT_AGENDA_DAYS}, maximum ${MAX_AGENDA_DAYS}.`,
      minimum: 1,
      maximum: MAX_AGENDA_DAYS,
    }),
  ),
});

export function createCalendarTool(deps: CalendarSources): AgentTool<typeof CalendarParams> {
  return {
    name: CALENDAR_TOOL_NAME,
    label: 'Calendar',
    description: [
      'Read local calendar events and the optional remote secret iCal feed together.',
      'Use it for "what have I got coming up", "am I free on Friday", "what time is',
      'the thing on Thursday". action=agenda, days=N to choose the window.',
      '',
      'Two limits you must state to the user instead of papering over:',
      '- READ-ONLY. It cannot create, move or cancel anything. If the user asks to',
      '  add or change an event, say plainly that this cannot do it and point them',
      '  at their calendar app. Do not offer to remember it as a substitute.',
      '- STALE applies only to the remote feed. Locally added events are read immediately. The feed is regenerated by the provider lazily and can lag reality by',
      '  up to about 24 hours, so it is reliable for planning days ahead and useless',
      '  for anything about the next few minutes. Never present it as live.',
      '',
      `The address lives in the vault under ${ICS_URL_KEY}; it is a read-only`,
      'password and is never printed or logged.',
    ].join('\n'),
    parameters: CalendarParams,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      if (args.action !== 'agenda') {
        throw new Error(`acción desconocida: ${String(args.action)}`);
      }

      const requested = Math.round(Number(args.days ?? DEFAULT_AGENDA_DAYS));
      const days = Number.isFinite(requested)
        ? Math.min(Math.max(1, requested), MAX_AGENDA_DAYS)
        : DEFAULT_AGENDA_DAYS;

      const source = await loadCalendarSources(deps);
      const { url } = source;
      const warnings: string[] = [];
      if (source.localError) warnings.push(source.localError);
      if (source.invalidUrl) {
        const message =
          'The stored calendar address is not a public http(s) URL, so it was refused. Check the vault entry.';
        if (!source.local) throw new Error(message);
        warnings.push(message);
      }
      if (source.remoteError) {
        const message = fetchFailureMessage(source.remoteError, url ?? '');
        if (!source.local) throw new Error(message);
        warnings.push(message);
      }
      if (!source.local && !source.remote && !warnings.length) {
        return {
          content: [{ type: 'text', text: MISSING_URL_TEXT }],
          details: { configured: false, key: ICS_URL_KEY },
        };
      }
      const now = new Date();
      const horizon = now.getTime() + days * DAY_MS;
      const events = mergeCalendarEvents(
        source.local ? parseIcs(source.local, now) : [],
        source.remote ? parseIcs(source.remote, now) : [],
      ).filter((event) => event.start.getTime() < horizon);
      log.info('calendar agenda', { days, events: events.length });
      return {
        content: [
          {
            type: 'text',
            text: [
              `Next ${days} day(s) from ${dayHeader(now)}:\n${summarizeForModel(events)}`,
              ...warnings,
            ].join('\n'),
          },
        ],
        details: {
          configured: true,
          days,
          events: events.length,
          stale: Boolean(source.remote),
          degraded: warnings.length > 0,
        },
      };
    },
  };
}
