/**
 * The nudge half of memory: noticing that a message said something durable
 * before the moment is gone.
 *
 * A model left to spontaneously decide "that was worth keeping" never does —
 * the turn moves on and the fact is gone by the next message. So detection is a
 * pure function over the user's text, cheap and predictable enough to run on
 * every message, while *saving* stays a human decision: a nudge is a question,
 * never a write. An agent that quietly files away what it overhears gets muted
 * the first time it guesses wrong.
 *
 * Categories are checked in priority order because a correction ("en realidad
 * me llamo Ana") outranks a preference: when both are present, the fact the
 * user is fixing is the one worth proposing. Everything is regexes on purpose —
 * a few hundred messages a week, no model round-trip, and a failure mode the
 * user can see in the wording of the nudge.
 */

import { looksLikeCredential } from '../memory.js';

export interface MemoryNudge {
  worth: boolean;
  /** Spanish, quoting the clause that triggered it. Empty when `worth` is false. */
  suggestion: string;
}

const NOTHING: MemoryNudge = { worth: false, suggestion: '' };

/** Below this a message is a ping, not a statement about the user. */
const MIN_CHARS = 15;

/**
 * `empezaré` and `mi café es` need `u`-mode classes and lookaheads: JS `\b`
 * and `\w` are ASCII-only, so a trigger ending in `é` would never match with a
 * trailing `\b`.
 */
const WORD_CHAR = '[\\p{L}\\p{N}_]';
/** Límite de palabra que trata «é», «ñ», «á»… como letras (el `\\b` de JS no lo hace). */
const UNICODE_BOUNDARY = `(?:(?<!${WORD_CHAR})(?=${WORD_CHAR})|(?<=${WORD_CHAR})(?!${WORD_CHAR}))`;
function unicodeWords(re: RegExp): RegExp {
  return new RegExp(re.source.replaceAll('\\b', UNICODE_BOUNDARY), re.flags);
}

const CATEGORIES: RegExp[][] = [
  // Corrección: the user is fixing something the agent believes.
  [/\bme llamo\b/iu, /\ben realidad\b/iu, /\bmejor dicho\b/iu, /\bno es\b[^.!?]*?\bsino\b/iu],
  // Preferencia.
  [/\bprefiero\b/iu, /\bme gustan?\b/iu, /\bodio\b/iu, /\bsiempre\b/iu, /\bnunca\b/iu],
  // Dato personal.
  [
    /(?<!\bque\s)\btengo\s/iu, // not "el correo que tengo"
    /\bmi\s+[\p{L}\p{N}_]+\s+es\b/iu,
    /\bvivo en\b/iu,
    /\btrabajo en\b/iu,
    /\bmi objetivo\b/iu,
  ],
  // Decisión.
  [/\bhe decidido\b/iu, /\bvoy a\b/iu, /\bempezar[ée](?!\p{L})/iu],
].map((patterns) => patterns.map(unicodeWords));

/**
 * What survives the question filter. "¿siempre llegas tarde?" is about the
 * agent and must never become a fact; "¿a qué hora quedamos? prefiero por la
 * tarde" carries a real preference in its own clause and does. A question that
 * names the user ("me llamo…", "tengo…") is an affirmation in disguise.
 */
const STRONG_AFFIRMATION = unicodeWords(
  /\b(?:me llamo|me llaman|prefiero|me gustan?|tengo|vivo en|trabajo en|mi objetivo|he decidido|voy a|mi\s+[\p{L}\p{N}_]+\s+es)\b/iu,
);

/** Everything that is only a greeting, so "hola, ¿qué tal?" is not a fact. */
const GREETINGS = new Set([
  'hola',
  'holi',
  'holis',
  'holo',
  'buenas',
  'buenos',
  'muy',
  'dias',
  'días',
  'tardes',
  'noches',
  'que',
  'qué',
  'tal',
  'hey',
  'hi',
  'hello',
  'eh',
  'ey',
  'oye',
  'saludos',
  'wenas',
]);

/**
 * Requests and questions that never carry a `?` (people are sloppy). Causal
 * "porque" and "como" are deliberately absent: "porque prefiero el té" is an
 * affirmation.
 */
const QUESTION_START = unicodeWords(
  /^(?:qué|cómo|cuándo|dónde|quién|cuál|cuánto|cuántos|cuántas|por qué|puedes|podrías|podrias|sabes|dime|what|how|when|where|why|who|which|can you|could you|would you|do you)\b/iu,
);

/**
 * A request, not a statement about the user: "resúmeme el último correo que
 * tengo" or "tengo 40 euros: busca el mejor tren" is a task. Asking to file it
 * in the profile interrupts a user who only wanted the task done. The verb may
 * open the region or follow a clause mark ("tengo 40 euros: busca ...").
 */
const REQUEST_VERB =
  '(?:resúmeme|resume|resumen|busca|búscame|dame|dime|haz|hazme|crea|créame|abre|ábreme|envía|envíame|manda|mándame|redacta|escribe|recuérdame|pon|ponme|lista|cancela|mira|llévame|reserva|compra|ayúdame|revisa|calcula|compara|traduce|explícame|genera|prepara|organiza)';
const REQUEST_REGION = new RegExp(`(?:^|[:,;]\\s*)${REQUEST_VERB}(?![\\p{L}])`, 'iu');
/** Where a quote cuts. Commas too: a quote is what the user recognises. */
const CLAUSE_MARK = /[.!?,;:…¡¿\n]/;

interface Region {
  text: string;
  question: boolean;
}

function trimClause(raw: string): string {
  return raw.replace(/^[,;:\s]+|[,;:\s]+$/g, '');
}

function startsLikeQuestion(body: string): boolean {
  return QUESTION_START.test(body);
}

/**
 * Sentences, not commas: "no es rojo, sino azul" must stay one piece for the
 * correction pattern to see it at all. A `¿` opens a question and a `?` closes
 * one, so "prefiero 1080p, ¿vale?" keeps its preference and drops the tag.
 */
function regionsOf(text: string): Region[] {
  const out: Region[] = [];
  let start = 0;
  let openedQuestion = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const ends = ch === '.' || ch === '!' || ch === '?' || ch === '…' || ch === '\n';
    const marksQuestion = ch === '¿' || ch === '¡';
    if (!ends && !marksQuestion) continue;
    const body = trimClause(text.slice(start, i));
    if (body) {
      out.push({
        text: body,
        question: openedQuestion || ch === '?' || startsLikeQuestion(body),
      });
    }
    openedQuestion = ch === '¿';
    start = i + 1;
  }
  const tail = trimClause(text.slice(start));
  if (tail) out.push({ text: tail, question: openedQuestion || startsLikeQuestion(tail) });
  return out;
}

/**
 * The quote is the clause the trigger lives in, because the nudge is read by
 * the user and a quote of the whole message would not show them *what* was
 * noticed. A bare trigger ("en realidad, prefiero el té" quoting only
 * "en realidad") shows nothing, so it widens to the whole region.
 */
function clauseAround(region: string, match: RegExpExecArray): string {
  const matched = match[0] ?? '';
  const end = match.index + matched.length;
  let lo = match.index;
  while (lo > 0 && !CLAUSE_MARK.test(region.charAt(lo - 1))) lo--;
  let hi = end;
  while (hi < region.length && !CLAUSE_MARK.test(region.charAt(hi))) hi++;
  const clause = trimClause(region.slice(lo, hi));
  return clause.length <= matched.length + 2 ? trimClause(region) : clause;
}

function suggest(clause: string): string {
  return `Parece que revelaste algo duradero: "${clause}". ¿Quieres que lo guarde en tu perfil?`;
}

export function detectMemoryWorthy(text: string): MemoryNudge {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) return NOTHING;
  if (looksLikeCredential(trimmed)) return NOTHING;
  const words = trimmed.toLowerCase().match(/[\p{L}]+/gu);
  if (words && words.length > 0 && words.every((word) => GREETINGS.has(word))) return NOTHING;

  const regions = regionsOf(text);
  for (const patterns of CATEGORIES) {
    for (const pattern of patterns) {
      for (const region of regions) {
        if (region.question && !STRONG_AFFIRMATION.test(region.text)) continue;
        if (REQUEST_REGION.test(region.text)) continue;
        const match = pattern.exec(region.text);
        if (!match) continue;
        return { worth: true, suggestion: suggest(clauseAround(region.text, match)) };
      }
    }
  }
  return NOTHING;
}
