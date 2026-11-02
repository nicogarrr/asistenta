/**
 * Vigilante semántico de turnos (idea «Watchdog» del diseño super-agente), en
 * dos fases para no gastar modelo a lo tonto:
 *
 * 1. Sospecha determinista (código, coste cero): el turno lleva un mínimo en
 *    marcha, no hay actividad nueva (pasos de herramienta) desde hace un rato
 *    y NO está aparcado esperando una aprobación del dueño (esperar a una
 *    persona no es estar atascado).
 * 2. Juicio con LLM (una llamada, solo tras la sospecha): el modelo lee los
 *    últimos pasos y decide si hay progreso real o un bucle. Solo si dice
 *    «atascado» se avisa al usuario, que decide: /stop o seguir esperando.
 *
 * COSTE: cada juicio es UNA llamada real al modelo configurado (una por turno
 * como mucho). Con un modelo/plan de pago consume cuota. Por eso va detrás de
 * PA_WATCHDOG=1 (apagado por defecto) y la fase 1 filtra casi todo.
 */

import { sliceSafe } from '../text.js';

/** Un turno más joven que esto nunca se juzga: arrancar también lleva tiempo. */
export const WATCHDOG_MIN_TURN_MS = 120_000;
/** Sin paso nuevo en todo este tiempo, con el turno vivo: sospecha. */
export const WATCHDOG_SUSPECT_MS = 300_000;
/** Pasos recordados por turno para el juicio (los más recientes). */
export const WATCHDOG_RECENT_STEPS = 12;

export interface WatchdogTurnState {
  startedAt: number;
  lastActivityAt: number;
  /** Últimos pasos (resúmenes de herramienta), más reciente al final. */
  steps: string[];
  /** Ya se juzgó este turno: un aviso como mucho por turno. */
  judged: boolean;
  /** Aparcado en una aprobación del dueño: esperar a una persona no es bucle. */
  awaitingApproval: boolean;
}

/** Estado por hilo de los turnos vivos. No persiste: un reinicio empieza de cero. */
export class TurnWatchdog {
  #turns = new Map<string, WatchdogTurnState>();

  begin(threadKey: string, now: number): void {
    this.#turns.set(threadKey, {
      startedAt: now,
      lastActivityAt: now,
      steps: [],
      judged: false,
      awaitingApproval: false,
    });
  }

  /** Un paso nuevo del turno (llamada a herramienta): actividad que reinicia la sospecha. */
  note(threadKey: string, step: string, now: number): void {
    const st = this.#turns.get(threadKey);
    if (!st) return;
    st.lastActivityAt = now;
    st.steps.push(step);
    if (st.steps.length > WATCHDOG_RECENT_STEPS) st.steps.shift();
  }

  awaiting(threadKey: string, waiting: boolean): void {
    const st = this.#turns.get(threadKey);
    if (st) st.awaitingApproval = waiting;
  }

  end(threadKey: string): void {
    this.#turns.delete(threadKey);
  }

  state(threadKey: string): WatchdogTurnState | undefined {
    return this.#turns.get(threadKey);
  }

  /** Marca el turno como juzgado (aunque el juicio falle: nada de reintentos en bucle). */
  markJudged(threadKey: string): void {
    const st = this.#turns.get(threadKey);
    if (st) st.judged = true;
  }

  /** ¿Cumple la sospecha determinista? Sin actividad reciente, turno maduro, sin juzgar. */
  suspect(threadKey: string, now: number): boolean {
    const st = this.#turns.get(threadKey);
    if (!st || st.judged || st.awaitingApproval) return false;
    return (
      now - st.startedAt >= WATCHDOG_MIN_TURN_MS && now - st.lastActivityAt >= WATCHDOG_SUSPECT_MS
    );
  }
}

/** Prompt del juicio (fase 2): solo los últimos pasos, respuesta JSON estricta. */
export function verdictPrompt(steps: readonly string[], elapsedMin: number): string {
  const trail = steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(sin pasos)';
  return [
    'Juzga si este turno de un asistente PROGRESA de verdad o está ATASCADO en bucle.',
    `Lleva ${elapsedMin} minutos. Últimos pasos:`,
    trail,
    '',
    'Progresa: cada paso aporta algo nuevo hacia el objetivo (instalar, descargar o',
    'esperar algo lento pero normal también cuenta como progreso).',
    'Atascado: repite lo mismo sin avanzar o alterna pasos sin producir nada.',
    'Responde SOLO con JSON: {"progresa": true} o {"progresa": false}.',
  ].join('\n');
}

/** Veredicto estricto: true/false; cualquier otra cosa es null (no se actúa). */
export function parseVerdict(raw: string): boolean | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
    .trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && 'progresa' in parsed) {
      const v = (parsed as { progresa: unknown }).progresa;
      if (typeof v === 'boolean') return v;
    }
  } catch {
    // null abajo
  }
  return null;
}

export interface WatchdogScanDeps {
  /** Juicio LLM inyectado (la red vive fuera: el módulo se prueba sin llamadas). */
  judge: (prompt: string) => Promise<boolean | null>;
  /** Aviso al dueño del hilo (texto ya en castellano llano). */
  tell: (threadKey: string, text: string) => Promise<void>;
  now?: () => number;
}

/**
 * Una pasada del vigilante: para cada hilo con turno vivo que cumpla la sospecha
 * determinista, pide UN juicio y avisa solo si el veredicto es «atascado».
 * Devuelve cuántos hilos se juzgaron (para logs/tests).
 */
export async function turnWatchdogScan(
  watchdog: TurnWatchdog,
  activeThreadKeys: Iterable<string>,
  deps: WatchdogScanDeps,
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let judged = 0;
  for (const key of activeThreadKeys) {
    if (!watchdog.suspect(key, now)) continue;
    watchdog.markJudged(key);
    judged += 1;
    const st = watchdog.state(key);
    if (!st) continue;
    const elapsedMin = Math.max(1, Math.round((now - st.startedAt) / 60_000));
    let verdict: boolean | null = null;
    try {
      verdict = await deps.judge(verdictPrompt(st.steps, elapsedMin));
    } catch {
      verdict = null;
    }
    // null (juicio ilegible o fallo de red) y true (progresa) callan: el aviso es
    // solo para atascos, y un falso positivo aquí es un susto innecesario.
    if (verdict === false) {
      const last = st.steps[st.steps.length - 1] ?? 'sin pasos';
      await deps.tell(
        key,
        `Llevo ${elapsedMin} minutos con esto y parece que no avanzo ` +
          `(último paso: «${sliceSafe(last, 60)}»). Si quieres lo paro con /stop; ` +
          'si es una espera normal, ignora este aviso.',
      );
    }
  }
  return judged;
}
