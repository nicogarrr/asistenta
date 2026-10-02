/**
 * Pure text shaping for the Telegram chat.
 *
 * Telegram's client renders almost none of markdown — a table shows up as a wall of
 * pipes and a header as literal hashes — while the model keeps emitting markdown
 * because it is what its training data looks like. These functions sit between the
 * two: they flatten model output into text that reads well in a chat bubble.
 *
 * Everything here is pure (no I/O, no bot, no clock) so the whole surface is
 * testable without a token or a network.
 */

/** Appended when a reply is cut short, so the user knows more is available. */
const DETAIL_HINT = 'Dime "más" para el detalle.';

/** ``` or ~~~ fences, with an optional language tag. */
const FENCE_LINE = /^\s*(?:```+|~~~+)\s*\w*\s*$/;

/** `#`-style headings. The marks are noise in a chat bubble; the words are not. */
const HEADER_LINE = /^#{1,6}\s+/;

/** Alignment row of a markdown table (`| --- | :---: |`); carries no content. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * A markdown table row: a pipe-delimited line that is framed by pipes. A plain
 * sentence that happens to contain a pipe stays prose.
 */
const TABLE_ROW = /^\s*\|.+\|\s*$/;

/**
 * Flatten model markdown into plain text for a chat bubble.
 *
 * Headers keep their words, fenced code keeps its lines (only the fence markers go:
 * they are what makes the bubble unreadable, the code is content), bold loses its
 * asterisks, and table rows become simple `a - b` lines so no information is lost
 * along with the pipes. `•` bullets become the plain dashes Telegram shows anyway.
 */
export function cleanForTelegram(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE_LINE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    // Inside a fence the text is code: rewriting `**` or `|` there would corrupt it.
    if (inFence) {
      out.push(rawLine);
      continue;
    }
    const row = toPlainTableRow(rawLine);
    if (row !== null) {
      if (row.length > 0) out.push(row);
      continue;
    }
    out.push(cleanInline(rawLine));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One table row as `cell - cell`, the separator row as nothing at all. */
function toPlainTableRow(line: string): string | null {
  const trimmed = line.trim();
  if (!TABLE_ROW.test(trimmed)) return null;
  if (TABLE_SEPARATOR.test(trimmed)) return '';
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  return cells.join(' - ');
}

/** Inline markdown on one line: headings, bold, inline code, bullet marks. */
function cleanInline(line: string): string {
  return line
    .replace(HEADER_LINE, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/•/g, '-')
    .replace(/^\s*[-*+]\s+/, '- ')
    .trimEnd();
}

/**
 * Cut a long reply at a word boundary and offer the rest on request.
 *
 * The whole result — body, ellipsis and hint — stays within `maxChars`, because the
 * point of the limit is a bubble you can read at a glance, not a bubble plus a
 * trailer. The cut never lands mid-word: a half word looks like a bug.
 */
export function shorten(text: string, maxChars = 300): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // Room for the ellipsis and the newline before the hint.
  const room = Math.max(1, maxChars - DETAIL_HINT.length - 2);
  const window = text.slice(0, room);
  const cutAt = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
  const body = (cutAt > 0 ? window.slice(0, cutAt) : window).trimEnd();
  return { text: `${body}…\n${DETAIL_HINT}`, truncated: true };
}

/**
 * A short "still working" phrase, in the user's language.
 *
 * One fixed phrase on every update reads like a stuck process, so the wording is
 * drawn at random. The phrases are deliberately vague: the agent does not know how
 * much is left, and a fake percentage is worse than no number at all.
 */
const PROGRESS_PHRASES = [
  'Sigo con ello',
  'Ya casi',
  'Voy por la mitad',
  'Ya está el proceso',
  'Todavía voy con ello',
  'Sigo en ello',
  'Ya falta poco',
  'Continúo con ello',
  'Voy bien, ya casi',
  'Sigo aquí dándole',
];

export function progressMessage(): string {
  const index = Math.floor(Math.random() * PROGRESS_PHRASES.length);
  return PROGRESS_PHRASES[index] ?? 'Sigo con ello';
}

/**
 * Discourse markers that announce a step rather than an outcome.
 */
const STEP_CONNECTOR =
  /^(?:y\s+|e\s+)?(?:primero(?:\s+de\s+todo)?|para empezar|luego|después(?:\s+de\s+eso)?|a continuación|acto seguido|seguidamente|mientras(?:\s+tanto)?|ahora(?:\s+bien)?|segundo|tercero|finalmente|por último|para terminar|tras\s+(?:eso|ello))[\s,:;–-]*/i;

/**
 * Sentence openers that are the agent doing something, not something being done.
 * This is the "voy a abrir YouTube, ahora pulso…" narration the user never asked for.
 */
const STEP_VERB =
  /^(?:voy a|vamos a|pulso|clico|pincho|hago clic|abro|cierro|escribo|copio|pego|selecciono|bajo|subo|espero|reviso|compruebo|busco|leo|ejecuto|llamo|relleno|marco|quito|inicio|cargo|instalo|descargo|entro|salgo|pauso|reproduzco|pongo|guardo|envío|mando|saco|meto|arranco|enciendo|apago|configuro)\b/i;

/** Clause boundaries: sentence ends, commas, and `y` before another step or result. */
const CLAUSE_BREAK =
  /(?<=[.!?…])\s+|,\s*|\s+y\s+(?=(?:primero|luego|después|ahora|a continuación|acto seguido|seguidamente|finalmente|por último|ya)\b)/i;

/** One sentence finishes with punctuation; a clause lifted out of one does not. */
const SENTENCE_END = /[.!?…]$/;

/**
 * Condense a narrated answer into ONE sentence of outcome.
 *
 * Step-by-step narration ("primero abro X, luego pulso Y") is dropped clause by
 * clause and the first surviving clause is kept — the outcome tends to open the
 * reply or stand alone at the end, while offers and follow-ups trail behind it.
 * When every clause was a step, the last one stands in for the result, minus its
 * "luego/después" opener.
 */
export function resultLine(text: string): string {
  const clauses = splitClauses(text);
  const outcome = clauses.find((clause) => !isStepClause(clause));
  const chosen = outcome ?? clauses.at(-1);
  if (!chosen) return '';
  return finish(chosen);
}

function splitClauses(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(CLAUSE_BREAK)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isStepClause(clause: string): boolean {
  return STEP_CONNECTOR.test(clause) || STEP_VERB.test(clause);
}

/** Drop a step opener if one is left, capitalise, and make it a full sentence. */
function finish(clause: string): string {
  const stripped = clause.replace(STEP_CONNECTOR, '').trim();
  if (!stripped) return '';
  const sentence = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return SENTENCE_END.test(sentence) ? sentence : `${sentence}.`;
}

/** One plain dash per item; empty entries are noise and are dropped. */
export function formatAsList(items: string[]): string {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => `- ${item}`)
    .join('\n');
}

/**
 * The turn layer prefixes a transcribed voice note so the model does not read a
 * misheard word as something the user typed. The prefix is transport bookkeeping,
 * not user text: this drops it so the model only ever sees what was said.
 */
const VOICE_PREFIX = /^\s*\[?\s*nota de voz transcrita\s*\]?\s*[:\-–—]?\s*/i;

export function stripVoicePrefix(text: string): string {
  return text.replace(VOICE_PREFIX, '');
}
