/**
 * Item 9b — the memory section of the context note as an index, not a raw dump.
 *
 * Until now buildContextNote pasted the last 20 entries verbatim, superseded
 * facts included: a corrected fact kept whispering its stale value on every
 * turn, and the section grew with the length of the text, not with the number
 * of things known. The 9a bench (scripts/memory-bench.ts) measured the
 * corpus: 6860 chars for 20 raw entries vs ~2800 for the hybrid chosen here —
 * the newest active entries in full, the rest as one-line index rows —
 * with superseded entries filtered out.
 *
 * An index only works if the full text stays reachable, and it is: the memory
 * tool answers action=get (exact entry by the [id] on the row), action=recall
 * (search) and action=list (every current entry), none of which ever returns
 * a replaced entry as if it were still true. The header says so, so the agent
 * drills down instead of guessing from a snippet.
 *
 * The section is capped at MEMORY_CONTEXT_CAP chars and degrades in two
 * phases (auditor #136 r1): first the oldest full entries compact to their
 * index row — a snippet beats a missing fact — and only once everything left
 * is already compact does the cap start dropping the oldest rows, with a tail
 * line saying how many are gone and how to see them. FULL_RECENT is a
 * maximum, never a promise: the cap wins.
 */
import type { MemoryEntry } from '../memory.js';

/** Hard ceiling for the rendered memory section, header and tail included. */
export const MEMORY_CONTEXT_CAP = 4000;
/** Max newest active entries that keep their full text; the cap can lower it. */
export const MEMORY_CONTEXT_FULL_RECENT = 5;
/** Index rows carry the first 80 chars, matching the 9a bench render. */
export const MEMORY_CONTEXT_SNIPPET = 80;

export interface MemoryContextRender {
  /** Section body: header, index rows, full recent entries, optional tail. */
  body: string;
  /** Active (non-superseded) entries in the input. */
  active: number;
  /** Superseded entries hidden from the note. */
  superseded: number;
  /** Entries left out entirely to fit MEMORY_CONTEXT_CAP. */
  hiddenByCap: number;
  /** Entries that kept their full text; the rest show as index rows. */
  fullShown: number;
}

const snip = (text: string) =>
  text.length > MEMORY_CONTEXT_SNIPPET ? `${text.slice(0, MEMORY_CONTEXT_SNIPPET)}…` : text;

function indexLine(entry: MemoryEntry): string {
  const tags = entry.tags.map((t) => `#${t}`).join(' ');
  return `- [${entry.id}] (${entry.date})${tags ? ` ${tags}` : ''} ${snip(entry.text)}`;
}

interface Row {
  entry: MemoryEntry;
  full: boolean;
}

const rowLine = (r: Row) => (r.full ? `- ${r.entry.text}` : indexLine(r.entry));

/**
 * Render the memory section of a chat's context note, or null when the chat
 * has no memory at all (the caller then omits the section, as before).
 *
 * `entries` is MemoryStore.all(scope): chronological, newest last, superseded
 * included. Superseded entries are never rendered — a corrected fact must not
 * keep answering after its correction, the same rule the memory tool's
 * recall/list/get apply.
 */
export function renderMemoryContext(entries: MemoryEntry[]): MemoryContextRender | null {
  if (entries.length === 0) return null;
  const active = entries.filter((e) => e.supersededBy === null);
  const superseded = entries.length - active.length;
  const header =
    `Memoria del chat: ${active.length} activas · ${superseded} superadas ocultas. ` +
    'Detalle exacto: memory action=get con el [id]; búsqueda: memory action=recall; ' +
    'activas: memory action=list.';
  const rows: Row[] = active.map((entry, i) => ({
    entry,
    full: i >= active.length - MEMORY_CONTEXT_FULL_RECENT,
  }));
  const tail = (k: number) => `- … y ${k} más (usa memory action=list)`;
  const build = (rs: Row[], hidden: number) =>
    [header, ...rs.map(rowLine), ...(hidden > 0 ? [tail(hidden)] : [])].join('\n');
  // Phase 1: compact the oldest full entries to index rows (never the newest).
  let fullShown = rows.filter((r) => r.full).length;
  while (fullShown > 1 && build(rows, 0).length > MEMORY_CONTEXT_CAP) {
    const oldestFull = rows.find((r) => r.full);
    if (!oldestFull) break;
    oldestFull.full = false;
    fullShown--;
  }
  // Phase 2: only then drop the oldest rows entirely, counted in the tail.
  let hidden = 0;
  while (rows.length > 1 && build(rows, hidden).length > MEMORY_CONTEXT_CAP) {
    rows.shift();
    hidden++;
  }
  let body = build(rows, hidden);
  // One pathological entry could exceed the cap on its own; the cap still holds.
  if (body.length > MEMORY_CONTEXT_CAP) body = `${body.slice(0, MEMORY_CONTEXT_CAP - 1)}…`;
  return { body, active: active.length, superseded, hiddenByCap: hidden, fullShown };
}
