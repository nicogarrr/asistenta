/**
 * Item 9c — the timeline layer of the memory pattern index → timeline → detail.
 *
 * The context index (9b) answers "what do I know" for the current turn; this
 * layer lists every saved note grouped by day, newest day first, inside one
 * capped view. Dates are REGISTRATION dates: MemoryEntry.date is the day the
 * note was saved, not when the fact happened and not a conversation log.
 * It is the HISTORY layer, so replaced entries are included — always marked
 * and linked to their replacement, exactly like the memory tool's
 * include_superseded, so history can never pass for a current fact.
 *
 * Before this, reviewing old notes cost either action=list (every entry full
 * text, uncapped) or action=recall (lexical ranking with 0% target-hit on old
 * entries, measured in 9a). The timeline is bounded: a date range, one line
 * per entry, and a hard cap that never cuts a row in half: it keeps the most
 * recent whole rows that fit, counts the ones it left out and hands back a
 * cursor that resumes inside the very day the page stopped at, so a day
 * bigger than the cap is still fully reachable. Detail stays one hop away:
 * memory action=get with the [id] on the row.
 */
import type { MemoryEntry } from '../memory.js';

/** Hard ceiling for a rendered timeline page, header and tail included. */
export const TIMELINE_CAP = 3000;
/** Rows carry the first 80 chars, matching the 9a/9b index render. */
export const TIMELINE_SNIPPET = 80;
/** Day key for entries whose registration date is missing or impossible. */
export const UNKNOWN_DAY = 'unknown';

/**
 * Room reserved for the "…N more, continue with cursor" tail once a page
 * truncates, so body + tail never exceed the cap.
 */
const TAIL_RESERVE = 200;

export interface TimelineRender {
  /** Timeline page: header, per-day groups, optional continuation tail. */
  body: string;
  /** Entries inside the requested range (superseded included). */
  inRange: number;
  /** Entries left out to fit the cap; all reachable through nextCursor. */
  hiddenByCap: number;
  /** Days with at least one row on this page (newest first). */
  days: number;
  /**
   * Continuation token "YYYY-MM-DD:offset" (or "unknown:offset") when
   * hiddenByCap > 0; pass it back as opts.cursor for the next page.
   * null when everything in range fit on this page.
   */
  nextCursor: string | null;
}

/** Strict YYYY-MM-DD that must also exist on the calendar. */
export function isValidISODate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const snip = (text: string) =>
  text.length > TIMELINE_SNIPPET ? `${text.slice(0, TIMELINE_SNIPPET)}…` : text;

/**
 * Every row is bounded so one row + header + tail ALWAYS fits the cap (the
 * store caps tag LENGTH, not tag COUNT). Over budget, tags are cut to a
 * whole-tag boundary with their hidden count declared and the snippet takes
 * the remaining room, always with an explicit ellipsis; the [id] and the
 * SUSTITUIDA→[id] mark are never cut.
 */
function timelineRow(e: MemoryEntry, budget: number): string {
  const prefix = `- [${e.id}]`;
  const mark = e.supersededBy ? ` SUSTITUIDA→[${e.supersededBy}]` : '';
  const tags = e.tags.map((t) => `#${t}`).join(' ');
  const full = `${prefix}${tags ? ` ${tags}` : ''}${mark} ${snip(e.text)}`;
  if (full.length <= budget) return full;
  // Reserve 20 for the " (+NNN tags) …" marker itself so out.length <= budget.
  const room = budget - prefix.length - mark.length - 20;
  if (room < 8) return `${prefix} …${mark}`;
  const tagPieces = e.tags.map((t) => `#${t}`);
  let tagsShown = 0;
  let tagsLen = 0;
  for (const piece of tagPieces) {
    const add = (tagsShown > 0 ? 1 : 0) + piece.length;
    if (tagsLen + add > room) break;
    tagsLen += add;
    tagsShown++;
  }
  const hiddenTags = e.tags.length - tagsShown;
  const tagsNote = hiddenTags > 0 ? ` (+${hiddenTags} tags)` : '';
  const snipRoom = room - tagsLen;
  const textPart = snipRoom > 8 ? ` ${snip(e.text).slice(0, snipRoom)}…` : '';
  return `${prefix} ${tagPieces.slice(0, tagsShown).join(' ')}${tagsNote}${textPart} …${mark}`;
}

const dayKey = (e: MemoryEntry): string => (isValidISODate(e.date) ? e.date : UNKNOWN_DAY);

interface DayPlan {
  day: string;
  total: number;
  start: number;
  rows: MemoryEntry[];
}

interface Page {
  lines: string[];
  shown: number;
  daysShown: number;
  hidden: number;
  stopDay: string;
  stopOffset: number;
}

/**
 * Render one page of the timeline for a scope's entries, or null when nothing
 * falls in the range (the tool turns that into an explicit "nothing that
 * week" answer instead of an empty block).
 *
 * `entries` is MemoryStore.all(scope): chronological, newest last, superseded
 * included. `from`/`to` are inclusive YYYY-MM-DD bounds. Entries without a
 * valid registration date group under "unknown" and appear only when no range
 * was requested: a range cannot vouch for a date it cannot read.
 *
 * `cursor` ("day:offset") resumes inside the day the last page stopped at;
 * newer days were already delivered. A spent or malformed cursor yields null.
 */
export function renderTimeline(
  entries: MemoryEntry[],
  opts: { from?: string; to?: string; cap?: number; cursor?: string } = {},
): TimelineRender | null {
  const cap = opts.cap ?? TIMELINE_CAP;
  const ranged = Boolean(opts.from || opts.to);
  const inRange = entries.filter((e) => {
    const k = dayKey(e);
    if (k === UNKNOWN_DAY) return !ranged;
    return (!opts.from || k >= opts.from) && (!opts.to || k <= opts.to);
  });
  if (inRange.length === 0) return null;

  let cursorDay: string | null = null;
  let cursorOffset = 0;
  if (opts.cursor) {
    const m = /^(.+):(\d+)$/.exec(opts.cursor);
    const day = m?.[1];
    if (!day || (day !== UNKNOWN_DAY && !isValidISODate(day))) return null;
    cursorDay = day;
    cursorOffset = Number(m?.[2]);
  }

  const byDay = new Map<string, MemoryEntry[]>();
  for (const e of inRange) {
    const k = dayKey(e);
    const day = byDay.get(k) ?? [];
    day.push(e);
    byDay.set(k, day);
  }
  const validDays = [...byDay.keys()]
    .filter((k) => k !== UNKNOWN_DAY)
    .sort()
    .reverse();
  const orderedDays = byDay.has(UNKNOWN_DAY) ? [...validDays, UNKNOWN_DAY] : validDays;
  // A cursor page starts inside its own day; newer days were already delivered.
  const days = cursorDay
    ? orderedDays.filter((d) =>
        cursorDay === UNKNOWN_DAY ? d === UNKNOWN_DAY : d <= cursorDay || d === UNKNOWN_DAY,
      )
    : orderedDays;
  // Newest first WITHIN the day too: MemoryStore.all is chronological
  // (newest last), so each day's list is reversed once; cursor offsets count
  // over that stable order.
  const plan: DayPlan[] = days.map((d) => {
    const all = [...(byDay.get(d) ?? [])].reverse();
    const start = d === cursorDay ? Math.min(cursorOffset, all.length) : 0;
    return { day: d, total: all.length, start, rows: all.slice(start) };
  });
  if (plan.every((p) => p.rows.length === 0)) return null; // spent cursor

  const replaced = inRange.filter((e) => e.supersededBy !== null).length;
  const unknownCount = byDay.get(UNKNOWN_DAY)?.length ?? 0;
  const span =
    validDays.length > 0
      ? ` entre ${validDays[validDays.length - 1]} y ${validDays[0]}`
      : ' sin fechas de registro válidas';
  const unknownNote = unknownCount > 0 ? ` · ${unknownCount} con fecha desconocida` : '';
  const rangeNote = ranged ? ` · rango ${opts.from ?? '…'}→${opts.to ?? '…'}` : '';
  const header =
    'Notas guardadas por día (fecha de registro, más reciente primero): ' +
    `${inRange.length} entradas (${replaced} sustituidas)${span}${unknownNote}${rangeNote}. ` +
    'Detalle exacto: memory action=get con el [id].';

  // One row + header + a day header + the tail always fits the cap.
  const rowBudget = Math.max(80, Math.min(400, cap - header.length - TAIL_RESERVE - 60));
  const remainingFrom = (i: number) => plan.slice(i).reduce((n, p) => n + p.rows.length, 0);
  // Rows are atomic: a page stops BETWEEN rows, counts what it leaves out and
  // says where to resume. The only overshoot is the forced first row of a
  // page bigger than the budget by itself — never a row cut in half.
  const paginate = (budget: number): Page => {
    const lines = [header];
    let used = header.length;
    let shown = 0;
    let daysShown = 0;
    let stopDay = '';
    let stopOffset = 0;
    let stoppedAt = -1;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const firstEntry = p?.rows[0];
      if (!p || !firstEntry) continue;
      const dayHead =
        p.day === UNKNOWN_DAY
          ? `fecha desconocida (${p.total}):`
          : p.start > 0
            ? `${p.day} (${p.total}, continúa en la ${p.start + 1}):`
            : `${p.day} (${p.total}):`;
      // Never a day header with zero rows under it: stop at the boundary.
      const firstRow = timelineRow(firstEntry, rowBudget);
      if (shown > 0 && used + 1 + dayHead.length + 1 + firstRow.length > budget) {
        stopDay = p.day;
        stopOffset = p.start;
        stoppedAt = i;
        break;
      }
      let shownHere = 0;
      let pushedHead = false;
      for (const [r, rowEntry] of p.rows.entries()) {
        const row = timelineRow(rowEntry, rowBudget);
        const fits = used + 1 + (pushedHead ? 0 : dayHead.length + 1) + row.length <= budget;
        if (!fits && shown > 0) {
          stopDay = p.day;
          stopOffset = p.start + r;
          stoppedAt = i;
          break;
        }
        if (!pushedHead) {
          lines.push(dayHead);
          used += 1 + dayHead.length;
          pushedHead = true;
        }
        lines.push(row);
        used += 1 + row.length;
        shown++;
        shownHere++;
        if (!fits) {
          // Forced first row of the page: pagination must always advance.
          stopDay = p.day;
          stopOffset = p.start + r + 1;
          stoppedAt = i;
          break;
        }
      }
      if (shownHere > 0) daysShown++;
      if (stoppedAt >= 0) break;
    }
    const stoppedPlan = stoppedAt >= 0 ? plan[stoppedAt] : undefined;
    const hidden = stoppedPlan ? remainingFrom(stoppedAt) - (stopOffset - stoppedPlan.start) : 0;
    return { lines, shown, daysShown, hidden, stopDay, stopOffset };
  };

  const full = paginate(cap);
  if (full.hidden === 0) {
    return {
      body: full.lines.join('\n'),
      inRange: inRange.length,
      hiddenByCap: 0,
      days: full.daysShown,
      nextCursor: null,
    };
  }
  const page = paginate(cap - TAIL_RESERVE);
  const cursor = `${page.stopDay}:${page.stopOffset}`;
  const tail =
    `- … ${page.hidden} entradas sin mostrar por el límite de ${cap} caracteres. ` +
    `Sigue con memory action=timeline cursor="${cursor}".`;
  return {
    body: [...page.lines, tail].join('\n'),
    inRange: inRange.length,
    hiddenByCap: page.hidden,
    days: page.daysShown,
    nextCursor: cursor,
  };
}
