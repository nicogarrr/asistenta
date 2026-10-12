/**
 * One answer to "¿qué tengo hoy?".
 *
 * WHY this file exists: the three sources the user has - the calendar feed, the
 * mailbox and the promises they made in chat - were three disconnected lists, each of
 * which answered a question nobody asked ("what is on the calendar") and none of
 * which answered the one everybody asks. This merges them into a single
 * `UnifiedAgenda` and renders it as text a chat client can display.
 *
 * DESIGN NOTES THAT ARE POLICY, NOT STYLE:
 *
 * - DEDUPLICATION IS A FEATURE, NOT AN OPTIMISATION. The confirmation of a train is
 *   in the inbox AND the train is in the calendar, because the user put it in both
 *   places. Listing it twice makes the agenda look broken and invites "which one is
 *   right?". The merged entry keeps both sources, so nothing is hidden either.
 *
 * - EVERY SOURCE IS OPTIONAL. Mail can be off, the vault can have no calendar, the
 *   follow-up database can be empty. `buildAgenda` takes factories, not clients, and
 *   each one is wrapped: a source that throws degrades the agenda and leaves a note,
 *   because a dropped IMAP socket must not be the reason "what do I have today" goes
 *   unanswered.
 *
 * - ORDER IS WHAT THE USER FEELS. A payment or a deadline for today comes before
 *   everything else even with no hour on it, because that is the thing that gets
 *   missed. Within the rest, the clock decides, and an item with no hour says so
 *   rather than pretending to be 09:00.
 *
 * The rendering is deliberately the plainest text that can work: no bold, no headings,
 * no tables, no asterisks. Telegram's Markdown parser turns `**` and `#` into noise or
 * an API error, and this is read on a phone.
 */

import type { Followup } from '../alerts/followups.js';
import { localTimeZone } from '../datecontext.js';
import { log } from '../log.js';
import type { MailMessage } from '../mail/types.js';
import { classifyKind, extractCommitments } from './extract.js';
import type { AgendaEvent } from './ics.js';
import { zonedDayKey, zonedDayStart, zonedParts } from './ics.js';

export type AgendaKind = 'meeting' | 'travel' | 'payment' | 'deadline' | 'reminder' | 'other';

/** Where an item was seen. Kept as one value per item, with `sources` alongside. */
export type AgendaWhere = 'calendario' | 'correo' | 'pendiente';

export interface AgendaItem {
  /** Epoch ms, or null when nothing is known - never a made-up date. */
  at: number | null;
  title: string;
  kind: AgendaKind;
  where: AgendaWhere;
  /** Present when the item came from a heuristic rather than from the user. */
  confidence?: number;
  /** False means "no hour on this": the renderer must not print one. */
  timed?: boolean;
  /** True for a `VALUE=DATE` calendar event. Rendered as "todo el día". */
  allDay?: boolean;
  /** True when the date is an expiry or renewal ("caduca", "renueva"): 30/7/1-day notices. */
  expiry?: boolean;
  /** Epoch ms, for a calendar event that lasts. */
  end?: number;
  location?: string;
  /**
   * Every source this item was seen in, once merged. Two entries means the calendar
   * and the mail agreed, which is worth showing: it is the user's own cross-check.
   */
  sources?: AgendaWhere[];
}

export interface UnifiedAgenda {
  /** Today, in the order the user should act on it. */
  today: AgendaItem[];
  /** The days after today, out to `days`. */
  upcoming: AgendaItem[];
  /** Open notes from the follow-up tracker, dated or not. */
  pending: AgendaItem[];
  /** Epoch ms the agenda was built for. */
  generatedAt: number;
  /** Window used for `upcoming`. */
  days: number;
  /** What each source contributed. */
  counts: { calendar: number; mail: number; pending: number };
  /** One line per source that failed. Empty in the happy path. */
  notes: string[];
}

export interface BuildAgendaDeps {
  calendar: () => Promise<AgendaEvent[]>;
  /** Optional: a mailbox that is not configured, or not wanted, is fine. */
  mail?: () => Promise<readonly MailMessage[]>;
  /**
   * Optional. Accepts the tracker's own `Followup` rows or already-shaped
   * `AgendaItem`s, so the wiring hands over what it has without reshaping it first.
   */
  followups?: () => Array<Followup | AgendaItem>;
  now?: () => number;
  days?: number;
  /** Zone "today" is a day in. Defaults to `localTimeZone()`. */
  timeZone?: string;
}

export interface FormatOptions {
  /** Reference point. Defaults to the agenda's own `generatedAt`. */
  now?: number;
  timeZone?: string;
}

const DAY_MS = 86_400_000;

const DEFAULT_DAYS = 7;

/**
 * Urgency, worst first. A deadline for today outranks a 09:00 standup even with no
 * hour on it, because the deadline is the one that gets missed.
 */
const KIND_PRIORITY: Record<AgendaKind, number> = {
  payment: 0,
  deadline: 0,
  travel: 1,
  meeting: 2,
  reminder: 3,
  other: 4,
};

const WHERE_TAG: Record<AgendaWhere, string> = {
  calendario: 'calendario',
  correo: 'correo',
  pendiente: 'pendiente',
};

/** Accented, because this is text for the user and not a pattern to match against. */
const WEEKDAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function clampDays(days: number | undefined): number {
  const requested = Math.round(Number(days ?? DEFAULT_DAYS));
  if (!Number.isFinite(requested)) return DEFAULT_DAYS;
  return Math.min(Math.max(1, requested), 60);
}

function isFollowup(value: Followup | AgendaItem): value is Followup {
  // The tracker row is called `subject` and carries a `dueAt`; an AgendaItem carries a
  // `title`. Two shapes in, and the caller decides which it has.
  return 'subject' in value && 'dueAt' in value;
}

/** A tracker row as an item. A `dueAt` of 0 means "no date, only contact recency". */
function fromFollowup(row: Followup): AgendaItem {
  const named: AgendaKind[] = ['payment', 'deadline', 'meeting', 'travel'];
  const kind = named.includes(row.kind as AgendaKind) ? (row.kind as AgendaKind) : 'reminder';
  return {
    at: row.dueAt > 0 ? row.dueAt : null,
    title: row.subject,
    kind,
    where: 'pendiente',
    timed: row.dueAt > 0,
  };
}

/** One calendar event as an item. The title is the user's own, so no confidence. */
function fromEvent(event: AgendaEvent): AgendaItem {
  return {
    at: event.start,
    title: event.title,
    // A calendar entry called "Vuelo a Lisboa" is travel and one called "Weekly sync"
    // is a meeting. The same word list the mail side uses, so an entry keeps its kind
    // through the merge instead of changing shape depending on where it came from.
    kind: classifyKind(event.title),
    where: 'calendario',
    timed: !event.allDay,
    allDay: event.allDay,
    end: event.end,
    ...(event.location ? { location: event.location } : {}),
  };
}

/** Fold a title down to what makes two of them the same thing. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words that carry no identity: "Billete confirmado" vs "Confirmación de billete". */
const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'y',
  'a',
  'en',
  'para',
  'con',
  'su',
  'sus',
  'confirmado',
  'confirmacion',
  'reserva',
  'viaje',
]);

function contentTokens(title: string): Set<string> {
  const tokens = titleKey(title).split(' ').filter(Boolean);
  const kept = tokens.filter((token) => !STOPWORDS.has(token));
  // A title made entirely of stopwords still has to compare on something.
  return new Set(kept.length > 0 ? kept : tokens);
}

/**
 * Is this the same thing twice?
 *
 * Same local day first, because a "1:1 with Ana" on Thursday and another on Friday are
 * two meetings. Then an exact key, then overlap - deliberately loose, because the
 * calendar holds "Tren Madrid - Barcelona" while the mail holds "Viaje Madrid →
 * Barcelona", and an exact string match would list the train twice, which is the
 * failure this whole file exists to prevent.
 */
function sameThing(a: string, b: string): boolean {
  const keyA = titleKey(a);
  const keyB = titleKey(b);
  if (keyA && keyA === keyB) return true;
  const tokensA = contentTokens(a);
  const tokensB = contentTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  const union = tokensA.size + tokensB.size - shared;
  if (union > 0 && shared / union >= 0.6) return true;
  const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  return small.size > 0 && [...small].every((token) => large.has(token));
}

/**
 * Fold two items that turned out to be one into one item.
 *
 * The calendar wins on `at`: the user put it there themselves, so it is the hour they
 * will act on, while the mail is a guess about a departure. `sources` records both, so
 * the entry is honest about having been seen twice instead of pretending one source
 * invented it.
 */
function mergeItems(primary: AgendaItem, other: AgendaItem): AgendaItem {
  return {
    ...primary,
    title:
      titleKey(primary.title).length >= titleKey(other.title).length ? primary.title : other.title,
    kind: KIND_PRIORITY[other.kind] < KIND_PRIORITY[primary.kind] ? other.kind : primary.kind,
    confidence: bestConfidence(primary.confidence, other.confidence),
    ...(primary.expiry || other.expiry ? { expiry: true } : {}),
    sources: [...new Set([...(primary.sources ?? [primary.where]), other.where])].sort(),
    ...(other.location && !primary.location ? { location: other.location } : {}),
  };
}

function bestConfidence(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Run one optional source. A broken source is a note in the agenda, not a throw.
 *
 * `Promise<T> | T` because the tracker is a synchronous sqlite read and forcing the
 * caller to wrap it in an async function it does not need would be noise.
 */
async function settle<T>(
  label: string,
  load: (() => T | Promise<T>) | undefined,
  fallback: T,
  notes: string[],
): Promise<T> {
  if (!load) return fallback;
  try {
    return await load();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`agenda: ${label} unavailable`, { err });
    notes.push(`No se ha podido leer ${label}: ${detail}`);
    return fallback;
  }
}

/**
 * Build the agenda. Every source is optional and every failure is contained, so this
 * returns whatever did answer rather than throwing at the caller.
 */
export async function buildAgenda(deps: BuildAgendaDeps): Promise<UnifiedAgenda> {
  const now = (deps.now ?? Date.now)();
  const days = clampDays(deps.days);
  const timeZone = deps.timeZone ?? localTimeZone();
  const notes: string[] = [];

  const events = await settle('el calendario', deps.calendar, [] as AgendaEvent[], notes);
  const messages = await settle('el correo', deps.mail, [] as readonly MailMessage[], notes);
  const rows = await settle(
    'los pendientes',
    deps.followups,
    [] as Array<Followup | AgendaItem>,
    notes,
  );

  const commitments = extractCommitments(messages, { now, horizonDays: days + 1, timeZone });
  const merged: AgendaItem[] = [
    ...events.map(fromEvent),
    ...commitments.map(
      (commitment): AgendaItem => ({
        at: commitment.at,
        title: commitment.subject,
        kind: commitment.kind,
        where: 'correo',
        confidence: commitment.confidence,
        ...(commitment.timed === undefined ? {} : { timed: commitment.timed }),
        ...(commitment.expiry ? { expiry: true } : {}),
      }),
    ),
  ];

  // Merge before splitting into days: two items can only be recognised as the same
  // thing once both are in hand.
  const deduped: AgendaItem[] = [];
  for (const item of merged) {
    const twin = deduped.find(
      (seen) =>
        seen.at !== null &&
        item.at !== null &&
        zonedDayKey(seen.at, timeZone) === zonedDayKey(item.at, timeZone) &&
        sameThing(seen.title, item.title),
    );
    if (twin) Object.assign(twin, mergeItems(twin, item));
    else deduped.push({ ...item, sources: item.sources ?? [item.where] });
  }

  const from = zonedDayStart(now, timeZone);
  const tomorrow = zonedDayStart(from + DAY_MS, timeZone);
  // `days` counts the days AFTER today, so the default 7 means "the next seven days"
  // and not "today plus six". A window one day short is a week of agenda that stops a
  // day early without saying so.
  const horizon = zonedDayStart(tomorrow + days * DAY_MS, timeZone);

  const dated = deduped.filter((item) => item.at !== null);
  const today = dated
    .filter((item) => (item.at ?? 0) >= from && (item.at ?? 0) < tomorrow)
    .sort(compare);
  const upcoming = dated
    .filter((item) => (item.at ?? 0) >= tomorrow && (item.at ?? 0) < horizon)
    .sort(compare);

  // Follow-ups keep their own section, dated first: a note with a due day the user
  // already passed is not something to act on today, and an undated note ("you have
  // not answered Juan in four days") has no place in a day's schedule.
  const pending = rows.map((row) =>
    isFollowup(row) ? fromFollowup(row) : { ...row, where: 'pendiente' as const },
  );
  pending.sort((a, b) => {
    if (a.at === null) return b.at === null ? a.title.localeCompare(b.title) : 1;
    if (b.at === null) return -1;
    return a.at - b.at || a.title.localeCompare(b.title);
  });

  return {
    today,
    upcoming,
    pending,
    generatedAt: now,
    days,
    counts: { calendar: events.length, mail: commitments.length, pending: pending.length },
    notes,
  };
}

/**
 * The order the user feels: urgent first even without an hour, then by the clock.
 *
 * A payment or a deadline for today leads, because it is the one that gets missed.
 * After that a timed item outranks an untimed one, then the hour, then the title, so
 * two runs over the same agenda produce the same text.
 */
function compare(a: AgendaItem, b: AgendaItem): number {
  const urgent = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
  if (urgent !== 0) return urgent;
  const timed = (b.timed === false ? 1 : 0) - (a.timed === false ? 1 : 0);
  if (timed !== 0) return timed;
  const at = (a.at ?? 0) - (b.at ?? 0);
  if (at !== 0) return at;
  return a.title.localeCompare(b.title);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `miércoles 05/03`, the header a group of items needs.
 *
 * The weekday comes from the calendar date at midday UTC rather than from `getDay()`
 * on the instant: a local midnight in Madrid is 22:00 UTC the day before, and asking
 * a `Date` what day it is would name yesterday.
 */
function dayLabel(at: number, timeZone: string): string {
  const parts = zonedParts(at, timeZone);
  const weekday =
    WEEKDAY_ES[new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)).getUTCDay()] ?? '';
  return `${weekday} ${pad(parts.day)}/${pad(parts.month)}`;
}

function timeLabel(at: number, timeZone: string): string {
  const parts = zonedParts(at, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** One bullet. No bold, no heading, no punctuation the user did not write. */
function bullet(item: AgendaItem, timeZone: string): string {
  const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 90) || '(sin título)';
  let prefix = '';
  if (item.allDay) prefix = 'todo el día  ';
  else if (item.timed === false) prefix = 'sin hora  ';
  else if (item.at !== null) prefix = `${timeLabel(item.at, timeZone)}  `;
  const tag =
    item.sources && item.sources.length > 1
      ? item.sources.map((where) => WHERE_TAG[where]).join('+')
      : WHERE_TAG[item.where];
  // Below 0.8 the item was assembled by heuristics, and the user is entitled to know
  // that before acting on it.
  const doubt =
    item.confidence !== undefined && item.confidence < 0.8
      ? ` (${Math.round(item.confidence * 100)}% seguro)`
      : '';
  return `- ${prefix}${title} (${tag})${doubt}`;
}

/**
 * The agenda as text for a chat client.
 *
 * Empty is one sentence rather than an empty message: "you have nothing" is an
 * answer, and a blank reply to "¿qué tengo hoy?" reads as a failure.
 */
export function formatAgenda(agenda: UnifiedAgenda, opts: FormatOptions = {}): string {
  const timeZone = opts.timeZone ?? localTimeZone();
  const reference = opts.now ?? agenda.generatedAt;
  const lines: string[] = [];

  if (agenda.today.length > 0) {
    lines.push('Hoy');
    for (const item of agenda.today) lines.push(bullet(item, timeZone));
  }

  const tomorrow = zonedDayStart(zonedDayStart(reference, timeZone) + DAY_MS, timeZone);
  const endOfTomorrow = zonedDayStart(tomorrow + DAY_MS, timeZone);
  const tomorrowItems = agenda.upcoming.filter(
    (item) => item.at !== null && item.at >= tomorrow && item.at < endOfTomorrow,
  );
  const laterItems = agenda.upcoming.filter((item) => item.at === null || item.at >= endOfTomorrow);

  if (tomorrowItems.length > 0) {
    lines.push(`Mañana, ${dayLabel(tomorrow, timeZone)}`);
    for (const item of tomorrowItems) lines.push(bullet(item, timeZone));
  }

  if (laterItems.length > 0) {
    lines.push('Esta semana');
    let open = '';
    for (const item of laterItems) {
      if (item.at !== null) {
        const key = zonedDayKey(item.at, timeZone);
        if (key !== open) {
          open = key;
          lines.push(dayLabel(item.at, timeZone));
        }
      }
      lines.push(bullet(item, timeZone));
    }
  }

  if (agenda.pending.length > 0) {
    lines.push('Pendientes');
    for (const item of agenda.pending) {
      const when = item.at === null ? '' : `${dayLabel(item.at, timeZone)} `;
      lines.push(
        `- ${when}${item.title.replace(/\s+/g, ' ').trim().slice(0, 90) || '(sin título)'}`,
      );
    }
  }

  for (const note of agenda.notes) lines.push(note);

  if (lines.length === 0) return 'No tienes nada apuntado para hoy ni para los próximos días.';
  return lines.join('\n');
}
