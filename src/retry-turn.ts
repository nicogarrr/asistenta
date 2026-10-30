/**
 * F7 — /reintentar y /compactar.
 *
 * `/reintentar` vuelve a lanzar el último mensaje del dueño en esta
 * conversación quitando antes del historial la respuesta anterior (y lo que
 * el turno añadió), para no arrastrar una respuesta mala. Solo se rebobina si
 * el historial es el mismo de entonces: si se resumió o se reinició entre
 * medias, se reenvía sin tocar nada.
 */

export interface RetryableTurn<A = unknown, I = unknown> {
  text: string;
  images?: I[];
  /** Agente que tenía la conversación al empezar el turno. */
  agent: A;
  /** Mensajes en el historial justo antes del turno. */
  mark: number;
  /** Resúmenes hechos hasta entonces: si cambian, el índice ya no vale. */
  compactions: number;
}

export class LastTurns<A = unknown, I = unknown> {
  readonly #byThread = new Map<string, RetryableTurn<A, I>>();

  remember(threadKey: string, turn: RetryableTurn<A, I>): void {
    this.#byThread.set(threadKey, turn);
  }

  get(threadKey: string): RetryableTurn<A, I> | undefined {
    return this.#byThread.get(threadKey);
  }

  forget(threadKey: string): void {
    this.#byThread.delete(threadKey);
  }
}

/**
 * Quita del historial lo que añadió el último turno. Devuelve cuántos mensajes
 * quitó (0 si no era seguro: otro agente, otro resumen o un historial más corto).
 */
export function rewindLastTurn<A>(
  turn: Pick<RetryableTurn<A>, 'agent' | 'mark' | 'compactions'>,
  current: { agent: A; messages: unknown[]; compactions: number },
): number {
  if (current.agent !== turn.agent) return 0;
  if (current.compactions !== turn.compactions) return 0;
  if (turn.mark < 0 || turn.mark > current.messages.length) return 0;
  return current.messages.splice(turn.mark).length;
}

/** «~12,3 mil» para un número de tokens. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} mil`;
}
