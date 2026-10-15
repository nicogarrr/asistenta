/**
 * Item 9c — the timeline layer of the memory pattern index → timeline → detail.
 *
 * The context index (9b) answers "what do I know" for the current turn; this
 * layer answers "when did things happen" for the whole history of a chat:
 * every entry, grouped by day, newest day first, inside one capped view.
 * It is the HISTORY layer, so replaced entries are included — always marked
 * and linked to their replacement, exactly like the memory tool's
 * include_superseded, so history can never pass for a current fact.
 *
 * Before this, a question like "what did we talk about last week" cost either
 * action=list (every entry full text, uncapped) or action=recall (lexical
 * ranking with 0% target-hit on old entries, measured in 9a). The timeline is
 * bounded: a date range, one line per entry, a hard cap that drops the oldest
 * days first and says how to reach them. Detail stays one hop away:
 * memory action=get with the [id] on the row.
 */
import type { MemoryEntry } from '../memory.js';

/** Hard ceiling for a rendered timeline, header and tail included. */
export const TIMELINE_CAP = 3000;
/** Rows carry the first 80 chars, matching the 9a/9b index render. */
export const TIMELINE_SNIPPET = 80;

export interface TimelineRender {
  /** Timeline body: header, per-day groups, optional tail. */
  body: string;
  /** Entries inside the requested range (superseded included). */
  inRange: number;
  /** Entries left out entirely to fit TIMELINE_CAP. */
  hiddenByCap: number;
  /** Days shown (newest first). */
  days: number;
}

const snip = (text: string) =>
  text.length > TIMELINE_SNIPPET ? `${text.slice(0, TIMELINE_SNIPPET)}…` : text;

function timelineRow(e: MemoryEntry): string {
  const tags = e.tags.map((t) => `#${t}`).join(' ');
  const mark = e.supersededBy ? ` SUSTITUIDA→[${e.supersededBy}]` : '';
  return `- [${e.id}]${tags ? ` ${tags}` : ''}${mark} ${snip(e.text)}`;
}

/**
 * Render the timeline for a scope's entries, or null when nothing falls in
 * the range (the tool turns that into an explicit "nothing that week"
 * answer instead of an empty block).
 *
 * `entries` is MemoryStore.all(scope): chronological, newest last, superseded
 * included. `from`/`to` are inclusive YYYY-MM-DD bounds; string compare works
 * because the format is fixed-width ISO.
 */
export function renderTimeline(
  entries: MemoryEntry[],
  opts: { from?: string; to?: string; cap?: number } = {},
): TimelineRender | null {
  const cap = opts.cap ?? TIMELINE_CAP;
  const inRange = entries.filter(
    (e) => (!opts.from || e.date >= opts.from) && (!opts.to || e.date <= opts.to),
  );
  if (inRange.length === 0) return null;
  const replaced = inRange.filter((e) => e.supersededBy !== null).length;
  const dates = inRange.map((e) => e.date);
  const rangeNote = opts.from || opts.to ? ` · rango ${opts.from ?? '…'}→${opts.to ?? '…'}` : '';
  const header =
    `Historia del chat: ${inRange.length} entradas (${replaced} sustituidas) ` +
    `entre ${dates[0]} y ${dates[dates.length - 1]}${rangeNote}. ` +
    'Detalle exacto: memory action=get con el [id].';
  // Group by day, newest day first.
  const byDay = new Map<string, MemoryEntry[]>();
  for (const e of inRange) {
    const day = byDay.get(e.date) ?? [];
    day.push(e);
    byDay.set(e.date, day);
  }
  const days = [...byDay.keys()].sort().reverse();
  const tail = (k: number) =>
    `- … ${k} entradas más antiguas sin mostrar (acota con from/to, p.ej. from=${dates[0]})`;
  const build = (dayNames: string[], hidden: number) =>
    [
      header,
      ...dayNames.flatMap((d) => {
        const dayEntries = byDay.get(d) ?? [];
        return [`${d} (${dayEntries.length}):`, ...dayEntries.map(timelineRow)];
      }),
      ...(hidden > 0 ? [tail(hidden)] : []),
    ].join('\n');
  // Oldest days go first: recent history is the most likely target.
  let hidden = 0;
  const kept = [...days];
  while (kept.length > 1 && build(kept, hidden).length > cap) {
    const dropped = byDay.get(kept[kept.length - 1] ?? '') ?? [];
    kept.pop();
    hidden += dropped.length;
  }
  let body = build(kept, hidden);
  if (body.length > cap) body = `${body.slice(0, cap - 1)}…`;
  return { body, inRange: inRange.length, hiddenByCap: hidden, days: kept.length };
}
