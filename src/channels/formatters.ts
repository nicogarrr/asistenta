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

import { log, scrubLogText } from '../log.js';

/** Appended when a reply is cut short, so the user knows more is available. */
const DETAIL_HINT = 'Pulsa «📖 Ver todo» o dime «más».';

/**
 * What the truncation trailer costs: the ellipsis, the newline and the hint. The
 * budget has to absorb it, because the point of the limit is a bubble you can read
 * at a glance, not a bubble plus a trailer that pushes it over.
 */
const HINT_OVERHEAD = DETAIL_HINT.length + 2;

/**
 * Budget for prose. 300 characters is about five lines on a phone: long enough for
 * a real answer, short enough that it never turns into a wall of text.
 */
const DEFAULT_MAX_CHARS = 300;

/**
 * Budget for a reply carrying code, links or identifiers.
 *
 * The prose budget was tuned on sentences, and applying it to a snippet or a URL is
 * vandalism: a 20-line listing or a 200-character signed link lost its tail, and a
 * URL cut in half stops being a link at all. Telegram accepts 4096 characters per
 * message and the channel splits anything past 4000, so 3500 leaves room for the
 * trailer and still travels as a single bubble.
 */
const DEFAULT_HARD_MAX_CHARS = 3500;

const EN_WORDS = new Set(
  "the a an i i'll i've i'm it's is are was were be to of and or but not don't isn't doesn't can't let me my this that these those with for on in at by from as so if then now going need needs try trying tried stuck loop real actually think stop reset start starting checking check skill tool don't have has had will would should could here there what how why which about into out up down just directly first next again already still".split(
    ' ',
  ),
);
const ES_WORDS = new Set(
  'el la los las un una unos unas de del que y o pero no es son fue ser en con por para al se su sus lo le les mi tu me te nos como mas más ya hay he ha han has este esta estos estas ese esa pude puedo quiero tengo dime'.split(
    ' ',
  ),
);

/** True when a sentence is English reasoning rather than Spanish prose. */
function isEnglishSentence(sentence: string): boolean {
  if (/[áéíóúñ¿¡]/i.test(sentence)) return false;
  const words = sentence.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length < 4) return false;
  let en = 0;
  let es = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    if (ES_WORDS.has(w)) es++;
  }
  return en >= 2 && en > es * 2 && MONOLOGUE_MARKER.test(sentence);
}

/**
 * Only first-person reasoning is dropped: plain English content (a product title, "out of
 * stock", a quoted web result) can be the real answer and must reach the user untouched.
 */
const MONOLOGUE_MARKER =
  /\b(?:I\x27ll|I\x27ve|I\x27m|I\x27d|I don\x27t|I do not|I need to|I should|I can\x27t|I will|I have been|let me|let\x27s|going to|stuck|loop|bogged|my approach|the skill)\b/i;

/**
 * Drop English reasoning sentences that leaked into a Spanish reply ("I'll start by
 * checking...", "Let me go directly to..."). Leaked chunks arrive glued to the next
 * sentence without a space, even mid-word, so a lowercase-to-Capital splice followed
 * by an English-looking run also counts as a boundary. Never empties the reply: when
 * nothing Spanish would remain, or the text carries code, it is returned untouched.
 */
export function dropEnglishMonologue(text: string): string {
  if (text.includes('```')) return text;
  const marked = text.replace(/([a-záéíóúñ])(?=[A-Z][a-z']+ [A-Za-z']+ [A-Za-z']+ )/g, '$1\uE000');
  const parts = marked.split(/(?<=[.!?])\s*(?=[A-ZÁÉÍÓÚÑ¿¡])|\uE000/);
  if (parts.length < 2) return text;
  const dropped = parts.filter((part) => isEnglishSentence(part));
  const kept = parts.filter((part) => !dropped.includes(part));
  if (dropped.length === 0 || kept.length === 0) return text;
  for (const part of dropped)
    log.info('monologo en ingles descartado', { frase: part.trim().slice(0, 120) });
  return kept
    .map((part) => part.trim())
    .join(' ')
    .trim();
}

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
 * Headers keep their words, fenced code keeps its lines, bold loses its
 * asterisks, and table rows become simple `a - b` lines so no information is lost
 * along with the pipes. `•` bullets become the plain dashes Telegram shows anyway.
 *
 * Fenced blocks keep their ``` markers. Telegram renders those as a monospaced,
 * copy-friendly block, and unwrapping them left the code looking like an accidental
 * wall of text with no way to tell where it starts. The lines inside are still
 * never rewritten: they are content, not markup.
 */
export function cleanForTelegram(text: string, opts: { keepMarks?: boolean } = {}): string {
  text = dropEnglishMonologue(text);
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE_LINE.test(rawLine)) {
      inFence = !inFence;
      // Kept, and flushed left: Telegram only recognises a fence at the line start.
      out.push(rawLine.trim());
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
    out.push(opts.keepMarks ? keepInlineMarks(rawLine) : cleanInline(rawLine));
  }
  return collapseBlankRuns(out).join('\n').trim();
}

/**
 * Squeeze runs of blank lines down to one paragraph break, in prose only.
 *
 * Blank lines inside a fence are content: PEP 8 asks for two between top-level
 * definitions, and collapsing them to one changes the file the user is looking at.
 */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;
  for (const line of lines) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    const isBlank = line.trim().length === 0;
    blankRun = isBlank ? blankRun + 1 : 0;
    if (isBlank && blankRun > 1 && !inFence) continue;
    out.push(line);
  }
  return out;
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
 * Like {@link cleanInline}, but the emphasis the chat CAN show survives: a heading
 * becomes a bold line, `**negrita**` and `código` keep their marks. Only
 * {@link telegramHtml} reads these marks; {@link stripMarks} removes them.
 */
function keepInlineMarks(line: string): string {
  const heading = HEADER_LINE.test(line);
  let out = line
    .replace(HEADER_LINE, '')
    .replace(/•/g, '-')
    .replace(/^\s*[-*+]\s+/, '- ')
    .trimEnd();
  if (heading) {
    const words = out.replace(/\*\*/g, '').trim();
    out = words ? `**${words}**` : '';
  }
  return out;
}

/** Escape the three characters Telegram's HTML parse mode treats as markup. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One prose line: `código` spans first (never bolded inside), then **negrita**. */
function inlineToHtml(line: string): string {
  return line
    .split(/(`[^`\n]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
      return escapeTelegramHtml(part)
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
        .replace(/\*\*/g, '');
    })
    .join('');
}

/**
 * Render the marks kept by `cleanForTelegram(text, { keepMarks: true })` as
 * Telegram HTML (`parse_mode: 'HTML'`): `**x**` → <b>, `x` → <code>, fenced blocks
 * → <pre>. EVERYTHING else is escaped, so a `<`, `&` or `>` written by the model or
 * quoted from a mail can never be read as a tag. A fence left open (a cut chunk) is
 * closed at the end; a stray `**` is dropped rather than shown.
 */
export function telegramHtml(text: string): string {
  const out: string[] = [];
  let fence: string[] | null = null;
  let lang = '';
  const closeFence = () => {
    if (!fence) return;
    const body = escapeTelegramHtml(fence.join('\n'));
    out.push(
      lang ? `<pre><code class="language-${lang}">${body}</code></pre>` : `<pre>${body}</pre>`,
    );
    fence = null;
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE_LINE.test(line)) {
      if (fence) closeFence();
      else {
        fence = [];
        lang = (
          line
            .trim()
            .replace(/^(?:`+|~+)/, '')
            .match(/^[\w+-]+/)?.[0] ?? ''
        ).toLowerCase();
      }
      continue;
    }
    if (fence) fence.push(line);
    else out.push(inlineToHtml(line));
  }
  closeFence();
  return out.join('\n');
}

/**
 * Texto del usuario (un recordatorio, una cita, un objetivo) dentro de una respuesta con
 * formato marks: sus `**` y acentos graves se neutralizan para que nunca se lean como
 * negrita o código. `**` lleva un separador invisible (U+2060) y se sigue viendo igual;
 * el acento grave pasa a «ˋ» (U+02CB), casi idéntico.
 */
export function escapeMarks(text: string): string {
  return text.replace(/\*\*/g, '*\u2060*').replace(/`/g, '\u02CB');
}

/**
 * Respuesta de comando en texto plano → formato marks: todo se escapa (es texto del
 * usuario o del calendario) y solo las líneas que `isTitle` reconoce van en negrita.
 */
export function marksWithTitles(text: string, isTitle: (line: string) => boolean): string {
  return text
    .split('\n')
    .map((line) => {
      const safe = escapeMarks(line);
      return line.trim() && isTitle(line) ? `**${safe.trim()}**` : safe;
    })
    .join('\n');
}

/**
 * Cabeceras de /estado (formatStatus): la primera línea «Asistenta <versión> …
 * encendida desde hace …» y «Esta conversación:». Las líneas de herramientas, log y
 * errores recientes no son títulos (un error puede empezar por cualquier cosa).
 */
export function isStatusTitle(line: string): boolean {
  return (
    /^Asistenta \S+ \(Node [^)]*\), encendida desde hace /.test(line) ||
    line === 'Esta conversación:'
  );
}

/** Cabeceras de /recordatorios (formatReminderRows). */
export function isReminderTitle(line: string): boolean {
  return /^Recordatorios: \d+$/.test(line);
}

/** Cabeceras de /agenda (formatAgenda, rutinas y objetivos de readAgendaOverview). */
export function isAgendaTitle(line: string): boolean {
  return (
    /^(?:Hoy|Esta semana|Pendientes|Objetivos abiertos)$/.test(line) ||
    /^Mañana, \S/.test(line) ||
    /^Rutinas programadas: \d+$/.test(line)
  );
}

/**
 * The same text with the kept marks removed: what the chat shows when Telegram
 * refuses the HTML. Fences stay (Telegram shows them as they are, and they mark
 * where code starts); `**` and inline backticks go, exactly like `cleanForTelegram`.
 */
export function stripMarks(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*/g, '');
    })
    .join('\n');
}

/** A fenced block, opened with ``` or ~~~, anywhere in the reply. */
const FENCE_START = /^[ \t]*(?:```|~~~)/m;

/** An indented code block: four spaces or a tab in front of non-blank text. */
const INDENTED_CODE = /^(?: {4}|\t)\S/m;

/** Any URL at all: one character too long for prose and it must survive whole. */
const URL_ANYWHERE = /\bhttps?:\/\/\S/;

/** A path is recognised by its separators, not by its shape. */
const PATH_SEPARATORS = /[\\/]/;

/** Long enough to be a hash, a uuid or a base64 blob rather than an ordinary word. */
const ID_TOKEN = /^[\w+/=-]{33,}$/;

/**
 * Tokens that must survive whole or not at all.
 *
 * A URL cut in half stops being a link, and half an address is worse than no
 * address: the reader cannot click it, cannot copy it and cannot tell what it was.
 * These are therefore never allowed to straddle a cut.
 */
const ATOMIC_TOKEN = /\bhttps?:\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;

/** Boundaries a cut may land on, best first: paragraph, then line, then word. */
const CUT_BOUNDARIES = ['\n\n', '\n', ' '] as const;

/** Half-open character range of something that has to stay together. */
interface Span {
  start: number;
  end: number;
}

/**
 * How much of a reply to keep, and how much of that budget is spent on prose.
 */
export interface ShortenOptions {
  /** Prose budget. Default 300. */
  maxChars?: number;
  /** Ceiling when the reply carries code or links. Default 3500. */
  hardMaxChars?: number;
}

/**
 * Does this reply carry something a sentence budget would destroy?
 *
 * Code, URLs, long paths and long identifiers are all worthless in halves: the
 * snippet the user asked for loses its ending, the link stops being clickable, the
 * path stops resolving. Prose is the only case where 300 characters is a kindness,
 * so this is the switch that picks between the two budgets.
 */
export function hasRichContent(text: string): boolean {
  if (FENCE_START.test(text)) return true;
  if (INDENTED_CODE.test(text)) return true;
  if (URL_ANYWHERE.test(text)) return true;
  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    if (token.length > 40 && PATH_SEPARATORS.test(token)) return true;
    if (ID_TOKEN.test(token) && hasMixedAlphabet(token)) return true;
  }
  return false;
}

/**
 * A real hash or encoded blob mixes character classes; a run of the same letter
 * repeated 300 times is a held-down key or a fixture, not an identifier. Calling it
 * one would hand a wall of noise the code budget it does not deserve.
 */
function hasMixedAlphabet(token: string): boolean {
  return [/[a-z]/, /[A-Z]/, /\d/, /[+/=-]/].filter((group) => group.test(token)).length >= 2;
}

/**
 * Cut a long reply at a safe boundary and offer the rest on request.
 *
 * A single budget used to serve every reply, which was fine for sentences and
 * destructive for everything else: a 20-line listing lost everything after the first
 * screen and a 200-character link was cut into a dead half. So the budget depends on
 * what the reply carries — prose keeps the short one, code and links get the ceiling
 * Telegram actually allows.
 *
 * Inside that budget the cut is still deliberate. It never lands inside a fenced
 * block (that would leave a bubble with an unterminated code block), never inside a
 * URL or address, and prefers a paragraph break over a line break over a space so the
 * text that survives reads as a whole thought. When there is no boundary left to
 * take, the block is dropped rather than halved.
 *
 * `maxChars` accepts a plain number so existing callers keep working.
 */
export function shorten(
  text: string,
  maxChars?: number | ShortenOptions,
): { text: string; truncated: boolean } {
  const options = resolveShortenOptions(maxChars);
  const rich = hasRichContent(text);
  const budget = rich ? options.hardMaxChars : options.maxChars;
  // Holgura en prosa: recortar 320 caracteres a 260 + aviso no ahorra lectura y
  // obliga a pulsar «Ver todo» para 60 caracteres (p. ej. una lista de 7 opciones
  // cortas). Solo se recorta si sobra al menos la mitad del presupuesto. El tope
  // duro (código, enlaces) no tiene holgura: ya roza el límite de Telegram.
  const allowed = rich ? budget : budget + Math.floor(budget / 2);
  if (text.length <= allowed) return { text, truncated: false };
  return { text: cutWithHint(text, budget), truncated: true };
}

function resolveShortenOptions(maxChars?: number | ShortenOptions): Required<ShortenOptions> {
  const given: ShortenOptions = typeof maxChars === 'number' ? { maxChars } : (maxChars ?? {});
  return {
    maxChars: given.maxChars ?? DEFAULT_MAX_CHARS,
    hardMaxChars: given.hardMaxChars ?? DEFAULT_HARD_MAX_CHARS,
  };
}

/**
 * The body, its ellipsis and the hint, together no longer than `budget`.
 *
 * The hint goes on last so it can never eat into the content: the alternative,
 * reserving room up front, is what used to shave characters off a code block or a
 * URL to pay for a sentence about them.
 */
function cutWithHint(text: string, budget: number): string {
  const limit = Math.max(1, budget - HINT_OVERHEAD);
  const tokens = atomicSpans(text);
  const fences = fenceSpans(text);
  const isWhole = (index: number): boolean => !insideAny(index, tokens);

  let cut = findCut(text, limit, (index) => isWhole(index) && !insideAny(index, fences));
  if (cut < 0) {
    // One unbroken run with no boundary outside a fence, typically a single very long
    // line of code. Half a URL is still worse than an incomplete listing, so keep
    // tokens whole and relax only the fence rule: a truncated snippet still reads as
    // code, whereas an over-long message is rejected by the channel outright.
    cut = findCut(text, limit, isWhole);
  }
  if (cut < 0) {
    // No boundary anywhere at all. Back out of whatever token the limit landed in
    // rather than shipping half of it.
    const straddled = tokens.find((span) => limit > span.start && limit < span.end);
    cut = straddled ? straddled.start : limit;
  }
  let body = text.slice(0, cut).trimEnd();
  // Una negrita **… partida por el corte se cierra: si no, telegramHtml no la
  // reconoce y el trozo visible pierde la negrita (o enseña los asteriscos).
  if (((body.match(/\*\*/g) ?? []).length & 1) === 1) body = `${body.replace(/\s+$/, '')}**`;
  return `${body}…\n${DETAIL_HINT}`;
}

/**
 * The last boundary at or before `limit` that `isSafe` allows, best boundary kind
 * first, or -1 when the run offers none.
 */
function findCut(text: string, limit: number, isSafe: (index: number) => boolean): number {
  for (const boundary of CUT_BOUNDARIES) {
    let index = text.lastIndexOf(boundary, limit);
    // Strictly decreasing: a position the search rejected cannot be asked again.
    while (index > 0) {
      if (isSafe(index)) return index;
      index = text.lastIndexOf(boundary, index - 1);
    }
    if (index === 0 && isSafe(0)) return 0;
  }
  return -1;
}

function atomicSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(ATOMIC_TOKEN)) {
    const start = match.index;
    if (start !== undefined) spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

/**
 * The fenced regions of the text, from the opening fence to the end of its closing
 * fence. An unclosed fence runs to the end of the reply, which is what the model
 * means when it stops mid-block.
 */
function fenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  const start = /^[ \t]*(?:```+|~~~+)/;
  let open = -1;
  let offset = 0;
  for (const line of text.split('\n')) {
    const isFence = start.test(line);
    if (isFence && open < 0) {
      open = offset;
    } else if (isFence) {
      spans.push({ start: open, end: offset + line.length });
      open = -1;
    }
    offset += line.length + 1;
  }
  if (open >= 0) spans.push({ start: open, end: text.length });
  return spans;
}

/** Would a cut at `index` leave `span` cut in half? */
function insideAny(index: number, spans: Span[]): boolean {
  return spans.some((span) => index > span.start && index < span.end);
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
  'Todavía voy con ello',
  'Sigo en ello',
  'Continúo con ello',
  'Sigo aquí dándole',
];

export function progressMessage(): string {
  const index = Math.floor(Math.random() * PROGRESS_PHRASES.length);
  return PROGRESS_PHRASES[index] ?? 'Sigo con ello';
}

/**
 * The text of a mid-turn "still working" note.
 *
 * It only says what is true. The old note was `<random phrase> - <lastSummary>.` with
 * `lastSummary` starting as the placeholder "recibido": a turn that was still
 * thinking sent "Ya casi - recibido.", and every note could claim "Voy por la mitad"
 * or "Ya falta poco" about work whose length nobody knows. That is filler, and the
 * user reads it as a promise. Now the note carries the elapsed time and, once a tool
 * has really started, what the agent is doing; before that it says it is thinking.
 */
export function progressNote(opts: {
  elapsedMs: number;
  /** Public-safe description of the latest started tool call; null when none yet. */
  summary: string | null;
  toolCalls: number;
}): string {
  const seconds = Math.max(0, Math.round(opts.elapsedMs / 1000));
  const elapsed =
    seconds < 90 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  const summary = opts.summary?.trim();
  if (!summary || opts.toolCalls === 0)
    return `${progressMessage()} (${elapsed}), todavía pensando.`;
  return `${progressMessage()} (${elapsed}): ${summary}.`;
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

/** Errores de red típicos de Node/undici: no dicen nada a quien lee el chat. */
const NETWORK_ERROR =
  /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network error|getaddrinfo)\b/i;
const TIMEOUT_ERROR =
  /\b(?:ETIMEDOUT|timed? ?out|timeout|AbortError|aborted|UND_ERR_[A-Z_]*TIMEOUT)\b/i;
const RATE_LIMIT_ERROR =
  /\b(?:429|rate[ _-]?limit(?:ed)?|too many requests|quota|resource[_ ]exhausted)\b/i;
const AUTH_ERROR =
  /\b(?:401|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|authentication|permission[_ ]denied)\b/i;
const OVERLOAD_ERROR =
  /\b(?:5\d\d|overloaded|service unavailable|bad gateway|internal server error)\b/i;
/** Fallos de programación: el texto es para el registro, no para el chat. */
const BUG_ERROR =
  /\b(?:Cannot read propert|Cannot set propert|is not a function|is not defined|is not iterable|undefined is not|null is not|Maximum call stack|Unexpected token|ReferenceError|TypeError|SyntaxError|RangeError)\b/;

/**
 * Lo que ve el usuario cuando un turno o un comando falla.
 *
 * Antes el chat recibía `Algo falló: ${err.message}` tal cual: «fetch failed»,
 * «Cannot read properties of undefined (reading 'text')», un 429 con el JSON del
 * proveedor entero o, con un Error de varias líneas, la pila. Ahora:
 * - las familias conocidas (red, tiempo agotado, límite de peticiones, clave inválida,
 *   proveedor caído, fallo interno) se cuentan en una frase en español con qué hacer;
 * - un mensaje propio corto y de una línea (los «Uso: …» o «No encuentro ese id» que
 *   lanzan los comandos) se respeta tal cual, con `prefix` delante si se da;
 * - nunca sale una pila, un JSON ni un secreto: se pasa por el mismo limpiador que el
 *   registro y se corta a 200 caracteres.
 */
export function friendlyError(err: unknown, prefix = ''): string {
  const raw =
    err instanceof Error
      ? `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}`
      : String(err ?? '');
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  const code = (err as { code?: unknown } | null)?.code;
  const probe = `${raw} ${typeof code === 'string' ? code : ''}`;
  if (BUG_ERROR.test(probe)) {
    return 'Se me ha roto algo por dentro y no he podido terminar. Queda apuntado en el registro; prueba otra vez o mira /estado.';
  }
  if (RATE_LIMIT_ERROR.test(probe)) {
    return 'El modelo de IA me está limitando por exceso de peticiones. Espera un minuto y repítemelo.';
  }
  if (AUTH_ERROR.test(probe)) {
    return 'El proveedor de IA ha rechazado la clave (no es válida o ha caducado). Revísala con «pa doctor» en el PC.';
  }
  if (TIMEOUT_ERROR.test(probe)) {
    return 'Ha tardado demasiado y lo he cortado. Prueba otra vez en un momento.';
  }
  if (NETWORK_ERROR.test(probe)) {
    return 'No he podido conectar (fallo de red). Vuelve a intentarlo en un momento.';
  }
  if (
    OVERLOAD_ERROR.test(probe) &&
    /\b(?:api|model|modelo|provider|proveedor|http|status)\b/i.test(probe)
  ) {
    return 'El servicio de IA está caído o saturado ahora mismo. Prueba de nuevo en unos minutos.';
  }
  const clean = scrubLogText(firstLine.replace(/^Error:\s*/, '')).trim();
  const looksTechnical =
    !clean || /[{}[\]]|\bat \S+:\d+|https?:\/\//.test(clean) || clean.length > 200;
  if (looksTechnical) {
    return 'Algo ha fallado y no he podido terminar. Queda apuntado en el registro; prueba otra vez o mira /estado.';
  }
  return `${prefix}${clean}`;
}
