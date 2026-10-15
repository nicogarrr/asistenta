/**
 * Item 9b — the memory section of the context note as an index, not a raw dump.
 *
 * Until now buildContextNote pasted the last 20 entries verbatim, superseded
 * facts included: a corrected fact kept whispering its stale value on every
 * turn, and the section grew with the length of the text, not with the number
 * of things known. The 9a bench (scripts/memory-bench.ts) measured the
 * corpus: 6860 chars for 20 raw entries vs 2828 for the hybrid chosen here —
 * the last 5 active entries in full, the rest as one-line index rows —
 * with superseded entries filtered out.
 *
 * An index only works if the full text stays reachable, and it already is:
 * the memory tool answers action=recall (search) and action=list (everything)
 * with complete entries. The header says so, so the agent drills down instead
 * of guessing from a snippet.
 *
 * The section is capped at MEMORY_CONTEXT_CAP chars. When it overflows, the
 * oldest rows are dropped first — recent facts survive, because they are the
 * ones a conversation is most likely to reference — and a tail line says how
 * many were left out and how to see them.
 */
import type { MemoryEntry } from '../memory.js';

/** Hard ceiling for the rendered memory section, header and tail included. */
export const MEMORY_CONTEXT_CAP = 4000;
/** How many of the newest active entries keep their full text. */
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
  /** Entries dropped to fit MEMORY_CONTEXT_CAP. */
  hiddenByCap: number;
}

const snip = (text: string) =>
  text.length > MEMORY_CONTEXT_SNIPPET ? `${text.slice(0, MEMORY_CONTEXT_SNIPPET)}…` : text;

function indexLine(entry: MemoryEntry): string {
  const tags = entry.tags.map((t) => `#${t}`).join(' ');
  return `- [${entry.id}] (${entry.date})${tags ? ` ${tags}` : ''} ${snip(entry.text)}`;
}

/**
 * Render the memory section of a chat's context note, or null when the chat
 * has no memory at all (the caller then omits the section, as before).
 *
 * `entries` is MemoryStore.all(scope): chronological, newest last, superseded
 * included. Superseded entries are never rendered — a corrected fact must not
 * keep answering after its correction, the same rule recall() already
 * applies.
 */
export function renderMemoryContext(entries: MemoryEntry[]): MemoryContextRender | null {
  if (entries.length === 0) return null;
  const active = entries.filter((e) => e.supersededBy === null);
  const superseded = entries.length - active.length;
  const header =
    `Memoria del chat: ${active.length} activas · ${superseded} superadas ocultas. ` +
    'Detalle completo: memory action=recall/list.';
  const recent = active.slice(-MEMORY_CONTEXT_FULL_RECENT);
  const older = active.slice(0, -MEMORY_CONTEXT_FULL_RECENT);
  const lines = [...older.map(indexLine), ...recent.map((e) => `- ${e.text}`)];
  const tail = (k: number) => `- … y ${k} más (usa memory action=list)`;
  const build = (rows: string[], hidden: number) =>
    [header, ...rows, ...(hidden > 0 ? [tail(hidden)] : [])].join('\n');
  const kept = [...lines];
  let hidden = 0;
  // Oldest rows go first: they are the least likely to matter to this turn.
  while (kept.length > 1 && build(kept, hidden).length > MEMORY_CONTEXT_CAP) {
    kept.shift();
    hidden++;
  }
  let body = build(kept, hidden);
  // One pathological entry could exceed the cap on its own; the cap still holds.
  if (body.length > MEMORY_CONTEXT_CAP) body = `${body.slice(0, MEMORY_CONTEXT_CAP - 1)}…`;
  return { body, active: active.length, superseded, hiddenByCap: hidden };
}
