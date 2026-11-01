/**
 * Should this run become a skill? The conservative half of procedural memory.
 *
 * The failure mode of a self-improving agent is not "too few skills", it is a
 * skills dir full of noise the model then dutifully follows. So a skill is only
 * proposed when three things hold at once: the task was genuinely multi-step
 * (three or more *distinct* tool calls), the outcome was a success (nobody
 * learns from a recipe that failed), and no similar skill already exists.
 *
 * Everything here is heuristic on purpose — the input is a free-text transcript,
 * not a typed event log. The parser accepts the transcript shapes this codebase
 * actually produces (`summarizeTranscript` lines, `tool: action` narration, and
 * JSON tool-call blobs such as the ones space-bunny-free leaks into text), and
 * it over-counts rather than under-counts narrator lines only when they look
 * like tool names. When the heuristics disagree with reality the answer is
 * "don't save": a missed skill is forgotten in a day, a bad skill is followed
 * forever.
 */

import { localDay } from '../datecontext.js';
import { foldAccents, sliceSafe } from '../text.js';
import type { Skill, SkillDraft } from './types.js';

/** How many different tool calls a task must have used before it is a recipe. */
export const MIN_DISTINCT_CALLS = 3;

export interface ToolCallStep {
  tool: string;
  /** Empty when the transcript named the tool but not its action. */
  action: string;
}

export interface SkillSuggestion {
  worth: boolean;
  /** Only present when `worth` is true: the skill to hand to `SkillStore.save`. */
  draft?: SkillDraft;
  /** Spanish, because it is read by the user and echoed back into the chat. */
  reason: string;
}

/**
 * Labels that narrate a transcript instead of calling a tool. Without this set
 * a line like `usuario: quiero reservar mesa` parses as a tool named "usuario"
 * and every chat inflates its tool count into skill territory.
 */
const NARRATOR_LABELS = new Set([
  'usuario',
  'user',
  'agente',
  'assistant',
  'asistenta',
  'system',
  'sistema',
  'herramienta',
  'tool',
  'tool_call',
  'llamada',
  'call',
  'nota',
  'note',
  'result',
  'resultado',
  'response',
  'respuesta',
  'summary',
  'resumen',
  'evolucion',
  'prompt',
  'task',
  'tarea',
  'goal',
  'objetivo',
  'contexto',
  'context',
  'error',
  'err',
  'warning',
  'warn',
  'aviso',
  'info',
  'debug',
  'ok',
  'hecho',
  'done',
  'fin',
  'paso',
  'step',
  'plan',
]);

/** `{"name":"computer","arguments":{"action":"click",...}}`, single line. */
const JSON_TOOL_CALL =
  /\{\s*"(?:name|toolName|tool_name)"\s*:\s*"([\w.-]+)"\s*,\s*"(?:arguments|args|input)"\s*:\s*\{([\s\S]*?)\}\s*\}/g;
const JSON_ACTION = /"action"\s*:\s*"([\w-]+)"/;
/** `herramienta: computer` / `tool: computer: click`, as produced by summarizeTranscript. */
const LABELLED_TOOL =
  /^(?:herramienta|tool|tool_call|llamada)\s*[:=]\s*([\w.-]+)(?:\s*[:=(]\s*([\w-]+))?/i;
/**
 * `computer: click`. The tool side must be lowercase so narration like
 * `Importante: llama luego` cannot be counted as a tool call.
 */
const PAIRED_TOOL = /^([a-z][a-z0-9_-]*)\s*:\s*(\S[\s\S]*)$/;
const USER_LINE = /^(?:usuario|user)\s*:\s*(.+)$/i;

/**
 * Words that make a request into a trigger phrase, stripped so the skill name
 * is "reservar mesa" rather than "quiero que reserves una mesa".
 */
const REQUEST_FILLER =
  /^(por favor,?\s+)?(puedes|podrías|podrias|me gustaría que|me gustaria que|quiero que|necesito que)\s+(me\s+)?(que\s+)?/i;

const FAILURE =
  /(^|[^a-záéíóúñ])(no (?:he )?podid[oa]s?|no pude|no se pudo|no pudimos|ha(?:n)? fallad[oa]s?|fall[óoa]s?|failed|failure|no funciona(?:ron)?|denegad(?:o|a|os|as)|rechazad(?:o|a|os|as)|bloquead(?:o|a|os|as)|timeout|timed out|unhandled exception|traceback|error al )([^a-záéíóúñ]|$)/i;

/**
 * Tool to category, so a draft groups with the skills it will live beside.
 * Only the tools this agent actually has; anything else lands in "general".
 */
const TOOL_CATEGORY: Readonly<Record<string, string>> = {
  browser: 'navegación',
  fetch: 'navegación',
  computer: 'escritorio',
  windows: 'escritorio',
  ocr: 'escritorio',
  shell: 'sistema',
  system: 'sistema',
  fs: 'sistema',
  memory: 'gestión',
  calendar: 'gestión',
  skills: 'gestión',
  media: 'archivos',
  voice: 'archivos',
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Tool calls in the order the transcript mentions them. */
export function extractToolCalls(transcript: string): ToolCallStep[] {
  const calls: ToolCallStep[] = [];
  for (const raw of transcript.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw
      .trim()
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)]\s+/, '');
    if (!line) continue;
    const jsonCalls = [...line.matchAll(JSON_TOOL_CALL)];
    if (jsonCalls.length > 0) {
      for (const match of jsonCalls) {
        const tool = match[1] ?? '';
        if (tool) calls.push({ tool, action: JSON_ACTION.exec(match[2] ?? '')?.[1] ?? '' });
      }
      continue;
    }
    const labelled = LABELLED_TOOL.exec(line);
    if (labelled?.[1]) {
      calls.push({ tool: labelled[1], action: (labelled[2] ?? '').trim() });
      continue;
    }
    const paired = PAIRED_TOOL.exec(line);
    const tool = paired?.[1] ?? '';
    if (tool && !NARRATOR_LABELS.has(tool) && paired?.[2] !== undefined) {
      calls.push({ tool, action: paired[2].trim() });
    }
  }
  return calls;
}

/** The user's own words: what a future request would look like. */
export function extractUserRequest(transcript: string): string {
  const lines = transcript.replace(/\r\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const match = USER_LINE.exec(raw.trim());
    if (match?.[1]) return sliceSafe(oneLine(match[1]), 300);
  }
  for (const raw of lines) {
    const line = oneLine(raw);
    if (line) return sliceSafe(line, 300);
  }
  return '';
}

/**
 * Success detection on the final answer text. Narrow on purpose: bare "error"
 * is not a failure ("arreglé el error del servidor" is a success), while "no
 * he podido" always is. Missing a skill is cheap; learning a recipe from a
 * failed run is not.
 */
export function resultLooksSuccessful(result: string): boolean {
  const text = result.trim();
  if (!text) return false;
  return !FAILURE.test(text);
}

function normalizeName(text: string): string {
  return foldAccents(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Fuzzy name match: equal, contained, or mostly the same words. */
export function fuzzyNameMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}

function shortTitle(ask: string): string {
  const stripped = ask.replace(REQUEST_FILLER, '');
  const first = stripped.split(/[.;!?]/)[0] ?? stripped;
  let title = '';
  for (const word of oneLine(first).split(' ').filter(Boolean)) {
    const next = title ? `${title} ${word}` : word;
    if (next.length > 60 && title) break;
    title = next;
  }
  return title || 'skill aprendido';
}

function categoryFor(calls: ToolCallStep[]): string {
  const tally = new Map<string, number>();
  for (const call of calls) {
    const category = TOOL_CATEGORY[call.tool.toLowerCase()] ?? 'general';
    tally.set(category, (tally.get(category) ?? 0) + 1);
  }
  let best = 'general';
  let bestCount = 0;
  for (const [category, count] of tally) {
    // Strict `>` keeps the first category on ties, so ordering is stable.
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

function buildDraft(request: string, calls: ToolCallStep[]): SkillDraft {
  const ask = request || 'tarea completada sin petición registrada';
  return {
    name: shortTitle(ask),
    description: ask,
    category: categoryFor(calls),
    whenToUse: `Cuando el usuario pida: ${ask}`,
    // The transcript is the only evidence there is: `tool: action` in order is
    // exactly what was done, which is what a recipe needs to be replayable.
    steps: calls.map((call) => (call.action ? `${call.tool}: ${call.action}` : call.tool)),
    notes: [`Generado automáticamente a partir de una transcripción el ${today()}.`],
  };
}

function today(): string {
  return localDay();
}

/**
 * The three gates, in the order that explains the answer cheapest first.
 * `existing` is optional so the heuristic stays testable in isolation, but the
 * skills tool passes the whole store: a second skill for the same task is how
 * a skill dir rots.
 */
export function decideToSave(
  transcript: string,
  result: string,
  existing: readonly Skill[] = [],
): SkillSuggestion {
  if (!transcript.trim()) {
    return {
      worth: false,
      reason:
        'No hay transcripción que analizar: sin ella no puedo ver qué herramientas se usaron.',
    };
  }
  if (!resultLooksSuccessful(result)) {
    return {
      worth: false,
      reason: `No merece la pena: el resultado de la tarea no fue un éxito y un skill solo debe guardar recetas que ya funcionaron.`,
    };
  }
  const calls = extractToolCalls(transcript);
  const distinct = [...new Set(calls.map((call) => `${call.tool}: ${call.action}`))];
  if (distinct.length < MIN_DISTINCT_CALLS) {
    return {
      worth: false,
      reason: `No merece la pena: la tarea usó ${calls.length} llamada(s) a herramientas pero solo ${distinct.length} distintas, y hacen falta ${MIN_DISTINCT_CALLS} o más para que un skill sea reutilizable.`,
    };
  }
  const draft = buildDraft(extractUserRequest(transcript), calls);
  const similar = existing.find((skill) => fuzzyNameMatch(draft.name, skill.name));
  if (similar) {
    return {
      worth: false,
      reason: `No merece la pena: ya existe un skill parecido, "${similar.name}" (${similar.id}). Mejora ese skill con improve en vez de crear otro.`,
    };
  }
  return {
    worth: true,
    draft,
    reason: `Merece la pena guardarse: la tarea usó ${distinct.length} herramientas/acciones distintas (${distinct.join(', ')}) y el resultado fue correcto. No hay ningún skill similar guardado.`,
  };
}
