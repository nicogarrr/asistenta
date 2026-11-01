/**
 * Cerrar el círculo, como lo haría una persona: algo con fecha que el dueño contó
 * («el dentista el martes a las 10», «me llega el paquete el jueves») ya ha pasado,
 * y Asistenta pregunta UNA vez qué tal fue, sin que nadie se lo pida.
 *
 * Los seguimientos con fecha ya se apuntaban (src/alerts/followups.ts), pero nadie
 * volvía a ellos: la fecha pasaba y el pendiente se quedaba ahí. Esto los recoge
 * después de la hora, uno cada vez, fuera de las horas de silencio, y no insiste.
 * Si el dueño contesta «ya está» / «hecho» poco después, el pendiente se cierra.
 */
import type { Followup } from '../alerts/followups.js';

/** Margen tras la hora: preguntar justo a la hora suena a reloj, no a persona. */
export const CHECKIN_GRACE_MS = 2 * 3_600_000;
/** Lo que pasó hace más de esto ya no se pregunta: sería raro sacarlo ahora. */
export const CHECKIN_MAX_AGE_MS = 3 * 24 * 3_600_000;
/** Entre dos preguntas de estas, como mínimo. */
export const CHECKIN_MIN_GAP_MS = 3 * 3_600_000;
/** Cuánto vale un «ya está» después de preguntar. */
export const CHECKIN_ANSWER_WINDOW_MS = 12 * 3_600_000;

/**
 * El seguimiento por el que toca preguntar, o null. Solo los que tienen fecha, ya
 * pasada (más el margen), no demasiado viejos y por los que todavía no se preguntó
 * después de la fecha (un aviso ANTES de la fecha no cuenta como pregunta).
 */
export function pickCheckIn(list: readonly Followup[], now: number): Followup | null {
  let best: Followup | null = null;
  for (const f of list) {
    if (f.status !== 'pending' || !(f.dueAt > 0)) continue;
    if (f.dueAt + CHECKIN_GRACE_MS > now || now - f.dueAt > CHECKIN_MAX_AGE_MS) continue;
    if ((f.pushedAt ?? 0) > f.dueAt) continue;
    if (!best || f.dueAt < best.dueAt) best = f;
  }
  return best;
}

/** Recorta el asunto para que la pregunta quepa en una línea. */
function shortSubject(subject: string): string {
  const clean = subject
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?¡¿]+$/u, '');
  return clean.length > 80 ? `${clean.slice(0, 79).trimEnd()}…` : clean;
}

const OPENERS = ['¿Qué tal fue lo de', '¿Cómo salió lo de', 'Oye, ¿qué tal lo de'];

/** La pregunta, corta y en llano. */
export function checkInLine(
  subject: string,
  pick: (n: number) => number = (n) => Math.floor(Math.random() * n),
): string {
  const opener = OPENERS[Math.abs(pick(OPENERS.length)) % OPENERS.length] ?? OPENERS[0];
  return `${opener} «${shortSubject(subject)}»? Si ya está, dime «ya está» y lo quito de pendientes.`;
}

/** «ya está», «hecho», «listo», «sí, ya»… dicho como respuesta corta. */
const DONE_ANSWER =
  /^(?:s[ií][,.!\s]+)?(?:ya\s+est[aá]|hecho|listo|ya\s+lo\s+hice|ya\s+fui|todo\s+bien|bien|perfecto|genial)(?:\s*[,.!]*\s*(?:gracias)?)?[.!\s]*$/iu;

export interface CloseLoopDeps {
  /** Seguimientos pendientes del DM del dueño (vacío si no hay dueño claro). */
  followups: () => readonly Followup[];
  markAsked: (id: string, at: number) => void;
  resolve: (id: string) => void;
  /** Manda al DM del dueño; false si no se pudo. */
  send: (text: string) => Promise<boolean>;
  now: () => number;
  /** Horas de silencio del dueño. */
  quiet: (now: number) => boolean;
  enabled: () => boolean;
}

/** El estado de un día de preguntas: cuándo fue la última y por qué. */
export class CloseLoop {
  #lastAt = 0;
  #asked: { id: string; subject: string; at: number } | null = null;
  readonly #deps: CloseLoopDeps;

  constructor(deps: CloseLoopDeps) {
    this.#deps = deps;
  }

  /** Un tic: pregunta por un seguimiento si toca. Devuelve el texto enviado, o null. */
  async tick(): Promise<string | null> {
    const d = this.#deps;
    if (!d.enabled()) return null;
    const now = d.now();
    if (d.quiet(now) || now - this.#lastAt < CHECKIN_MIN_GAP_MS) return null;
    const f = pickCheckIn(d.followups(), now);
    if (!f) return null;
    const text = checkInLine(f.subject);
    // Se marca ANTES de enviar: si el envío se cuelga y reintenta, mejor una pregunta
    // perdida que dos iguales.
    d.markAsked(f.id, now);
    this.#lastAt = now;
    if (!(await d.send(text).catch(() => false))) return null;
    this.#asked = { id: f.id, subject: f.subject, at: now };
    return text;
  }

  /**
   * El dueño ha escrito: si es un «ya está» poco después de la pregunta, se cierra
   * ese pendiente. Devuelve el cerrado (id y asunto), o null.
   */
  answered(text: string, now = this.#deps.now()): { id: string; subject: string } | null {
    const asked = this.#asked;
    if (!asked || now - asked.at > CHECKIN_ANSWER_WINDOW_MS) return null;
    if (!DONE_ANSWER.test(text.trim())) return null;
    this.#asked = null;
    this.#deps.resolve(asked.id);
    return { id: asked.id, subject: asked.subject };
  }
}

/** La confirmación nombra lo que se quita, para que se vea qué se ha hecho. */
export function closedLine(subject: string): string {
  return `Perfecto, quito «${shortSubject(subject)}» de pendientes.`;
}
