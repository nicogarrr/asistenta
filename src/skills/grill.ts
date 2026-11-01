/**
 * «Preguntas antes de lo grande»: adaptación de grill-me / grilling de Matt Pocock
 * (https://github.com/mattpocock/skills, MIT, Copyright (c) 2026 Matt Pocock), con
 * redacción propia. Una sola ronda para Telegram: 3–5 preguntas
 * numeradas con propuesta («sí» las acepta), resumen de 2–3 líneas y solo se empieza
 * con el «sí» del dueño. Cuándo preguntar lo decide el código, sin modelo; el modelo
 * solo redacta (y sin modelo hay preguntas fijas).
 */

import { detectFeatureRequest } from '../evolve/ask.js';
import { sliceSafe } from '../text.js';

/** «hazlo ya», «sin preguntas»…: el dueño no quiere entrevista. */
const SKIP =
  /\b(?:sin preguntas|hazlo ya|hazlo directamente|empieza ya|no me preguntes|sin rodeos)\b/i;

/** Encargos pequeños y claros: no se interrogan nunca. */
const SMALL =
  /\b(?:tele|televisi[oó]n|tiempo hace|qu[eé] tiempo|recu[eé]rdame|recordatorio|alarma|temporizador|volumen|m[uú]sica|canci[oó]n|qu[eé] hora|apaga|enciende|sube|baja|pausa)\b/i;

/** Plan, proyecto o algo a construir. */
const BIG =
  /\b(?:planif[ií]ca(?:me)?|organ[ií]za(?:me)?|(?:prepara|haz)(?:me)? un plan|plan (?:de|para)|dis[eé][nñ]a(?:me)?|m[oó]nta(?:me)?|automat[ií]za(?:me)?|cr[eé]a(?:me)? (?:un|una) (?:app|aplicaci[oó]n|web|p[aá]gina|sistema|rutina|automatizaci[oó]n|bot|programa|presupuesto|itinerario|proyecto)|ay[uú]dame a (?:planificar|organizar|montar|preparar|decidir|elegir)|quiero (?:montar|organizar|preparar|planificar|crear) (?:un|una|mi))\b/i;

/** Pasos encadenados: «y luego», «después», «primero»… */
const STEP =
  /\b(?:y luego|luego|despu[eé]s|y despu[eé]s|adem[aá]s|primero|por [uú]ltimo|al final)\b/gi;

export type GrillTrigger = { feature: boolean } | null;

/** ¿Merece una ronda de preguntas antes de empezar? Sin modelo, determinista. */
export function grillTrigger(raw: string): GrillTrigger {
  const text = raw.trim();
  if (!text || text.startsWith('/') || text.length > 1500) return null;
  if (SKIP.test(text)) return null;
  if (detectFeatureRequest(text)) return { feature: true };
  if (text.split(/\s+/).length < 5) return null;
  if (BIG.test(text)) return { feature: false };
  // Varios pasos encadenados, salvo que sea un encargo pequeño de la casa.
  const steps = text.match(STEP)?.length ?? 0;
  if (steps >= 2 && !SMALL.test(text)) return { feature: false };
  return null;
}

export const GRILL_QUESTIONS_PROMPT = `Eres Asistenta, la asistente personal de Nico. Te ha pedido algo grande o abierto. \
Antes de empezar, hazle UNA ronda de 3 a 5 preguntas cortas en castellano llano, numeradas (1., 2., …). \
Pregunta solo decisiones que son suyas (qué quiere, límites, prioridad, cuándo, cómo sabrá que está bien); \
no preguntes datos que puedes averiguar tú. Cada pregunta en una línea, con tu propuesta entre paréntesis \
para que baste con responder «sí». Devuelve solo la lista numerada, sin saludo ni explicación.`;

export const GRILL_SPEC_PROMPT = `Eres Asistenta. Con el encargo de Nico y sus respuestas, escribe el resumen \
de lo que vas a hacer: de 2 a 3 líneas cortas en castellano llano (qué harás, qué no harás, cómo sabrá que \
está hecho). Si una respuesta es «sí», acepta la propuesta de esa pregunta. Devuelve solo esas líneas.`;

/** Preguntas de reserva si no hay modelo o su respuesta no sirve. */
export const FALLBACK_QUESTIONS = [
  '¿Qué quieres tener al final, en concreto? (Propongo: lo mínimo que ya te sirva)',
  '¿Hay algo que no deba hacer o tocar, como pagar, escribir a otros o borrar? (Propongo: nada de eso sin preguntarte)',
  '¿Para cuándo lo necesitas? (Propongo: sin prisa, cuando esté bien hecho)',
];

export const GRILL_INTRO = 'Antes de empezar, unas preguntas rápidas:';
export const GRILL_OUTRO =
  'Contesta en un mensaje («sí» acepta mis propuestas). Si prefieres que empiece ya, dime «hazlo ya».';
export const GRILL_CONFIRM = '¿Empiezo? Dime «sí», o corrígeme.';
export const GRILL_DROPPED = 'Vale, lo dejo.';

/** Una orden pequeña que llega con la ronda abierta: se atiende aparte. */
const SMALL_COMMAND =
  /^(?:pon|apaga|enciende|sube|baja|pausa)\b.*\b(?:tele|televisi[oó]n|volumen|m[uú]sica|canci[oó]n|luz|luces|radio)\b|^recu[eé]rdame\b|^¿?qu[eé] (?:tiempo|hora)\b/i;

const PENDING_MS = 30 * 60_000;
const YES = /^(?:s[ií]|vale|venga|adelante|ok|okay|perfecto|de acuerdo|empieza|dale)(?![\p{L}])/iu;
const NO =
  /^(?:no|cancela|d[eé]jalo|olv[ií]dalo)(?:[,\s]+(?:d[eé]jalo|gracias|olv[ií]dalo))?[.!\s]*$/iu;

export type GrillLlm = (
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
) => Promise<string>;

export interface GrillDeps {
  /** Modelo para redactar; ausente o con error, se usan las preguntas de reserva. */
  llm?: GrillLlm;
  reply: (text: string) => Promise<void>;
  now?: () => number;
}

interface Pending {
  request: string;
  feature: boolean;
  stage: 'questions' | 'spec';
  questions: string[];
  answers: string[];
  spec: string;
  at: number;
}

export type GrillResult =
  | { kind: 'pass' }
  | { kind: 'handled' }
  | { kind: 'go'; feature: boolean; request: string; spec: string; text: string };

/** Saca 3–5 preguntas de una lista numerada; null si no hay al menos 3. */
export function parseQuestions(raw: string): string[] | null {
  const qs = raw
    .split('\n')
    .map((l) => /^\s*\d+\s*[.)-]\s*(.+?)\s*$/.exec(l)?.[1])
    .filter((q): q is string => !!q)
    .map((q) => sliceSafe(q.replace(/\*\*/g, ''), 240));
  return qs.length >= 3 ? qs.slice(0, 5) : null;
}

function clip(lines: string, max: number): string {
  return lines
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, max)
    .map((l) => sliceSafe(l, 220))
    .join('\n');
}

export class GrillMe {
  private readonly pending = new Map<string, Pending>();

  isPending(key: string, now = Date.now()): boolean {
    const p = this.pending.get(key);
    return !!p && now - p.at <= PENDING_MS;
  }

  async handle(key: string, raw: string, deps: GrillDeps): Promise<GrillResult> {
    const now = (deps.now ?? Date.now)();
    const text = raw.trim();
    const waiting = this.pending.get(key);
    if (waiting && now - waiting.at > PENDING_MS) this.pending.delete(key);
    const p = this.pending.get(key);
    if (p) {
      // Algo pequeño y nuevo («pon la tele») en medio: se atiende y la ronda sigue abierta.
      if (SMALL_COMMAND.test(text) && text.length < 80) {
        return { kind: 'pass' };
      }
      if (NO.test(text)) {
        this.pending.delete(key);
        await deps.reply(GRILL_DROPPED);
        return { kind: 'handled' };
      }
      p.at = now;
      if (SKIP.test(text) || (p.stage === 'spec' && YES.test(text))) {
        this.pending.delete(key);
        return this.go(p);
      }
      p.answers.push(text);
      p.spec = await this.spec(p, deps);
      p.stage = 'spec';
      await deps.reply(`Entonces:\n${p.spec}\n\n${GRILL_CONFIRM}`);
      return { kind: 'handled' };
    }
    const trigger = grillTrigger(text);
    if (!trigger) return { kind: 'pass' };
    const questions = await this.questions(text, deps);
    this.pending.set(key, {
      request: text,
      feature: trigger.feature,
      stage: 'questions',
      questions,
      answers: [],
      spec: '',
      at: now,
    });
    const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await deps.reply(`${GRILL_INTRO}\n${list}\n\n${GRILL_OUTRO}`);
    return { kind: 'handled' };
  }

  private async questions(request: string, deps: GrillDeps): Promise<string[]> {
    if (!deps.llm) return [...FALLBACK_QUESTIONS];
    try {
      const out = await deps.llm(GRILL_QUESTIONS_PROMPT, `Encargo de Nico: ${request}`, 400);
      return parseQuestions(out) ?? [...FALLBACK_QUESTIONS];
    } catch {
      return [...FALLBACK_QUESTIONS];
    }
  }

  private async spec(p: Pending, deps: GrillDeps): Promise<string> {
    const fallback = `Haré: ${sliceSafe(p.request, 200)}\nTeniendo en cuenta: ${sliceSafe(p.answers.join(' / '), 200)}`;
    if (!deps.llm) return fallback;
    const qa = p.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    try {
      const out = await deps.llm(
        GRILL_SPEC_PROMPT,
        `Encargo: ${p.request}\n\nPreguntas:\n${qa}\n\nRespuestas de Nico:\n${p.answers.join('\n')}`,
        300,
      );
      return clip(out, 3) || fallback;
    } catch {
      return fallback;
    }
  }

  private go(p: Pending): GrillResult {
    const answers = p.answers.length ? p.answers.join('\n') : '(sin respuestas: empezar ya)';
    const text = [
      p.request,
      '',
      'Aclaraciones de Nico antes de empezar:',
      answers,
      ...(p.spec ? ['', 'Plan acordado:', p.spec] : []),
    ].join('\n');
    return { kind: 'go', feature: p.feature, request: p.request, spec: p.spec, text };
  }
}
