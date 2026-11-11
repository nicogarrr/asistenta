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
  /** message_id del mensaje del dueño: el botón «🔄 Reintentar» solo repite ESE mensaje. */
  messageId?: string;
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

/** Etiqueta del botón que sale bajo una respuesta que falló. */
export const RETRY_BUTTON_LABEL = '🔄 Reintentar';

/** Aviso si el botón «🔄 Reintentar» es de un mensaje que ya no es el último. */
export const RETRY_STALE_TEXT =
  'Ese botón es de un mensaje anterior y ya me has escrito después. Si aún lo quieres, mándamelo otra vez.';

/**
 * El message_id que lleva «/reintentar <id>» (el botón), o undefined si se escribió a
 * mano sin id (entonces repite el último, como siempre).
 */
export function retryTarget(text: string): string | undefined {
  return /^\/reintentar(?:@\w+)?\s+(\d{1,20})\s*$/i.exec(text.trim())?.[1];
}

/**
 * «/compactar reintentar <id>» (botón «🗜️ Resumir y reintentar» de la tarjeta de error): el
 * id del mensaje que repetir tras resumir; undefined si es un /compactar normal.
 */
export function compactarRetryTarget(args: string): string | undefined {
  return /^reintentar\s+(\d{1,20})\s*$/i.exec(args.trim())?.[1];
}

/**
 * ¿Repite el botón el último mensaje? Un botón viejo (ya se escribió otra cosa después)
 * no debe repetir un mensaje distinto del que falló.
 */
export function retryMatches(last: { messageId?: string } | undefined, target?: string): boolean {
  if (target === undefined) return true;
  return last?.messageId === target;
}

/** «~12,3 mil» para un número de tokens. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} mil`;
}
