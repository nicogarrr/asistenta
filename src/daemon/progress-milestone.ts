/**
 * Cuándo vale la pena tocar la nota de progreso de un turno largo. Antes salía a los
 * 25 s y se reescribía cada 45 s solo para cambiar el tiempo: un goteo. Ahora, como lo
 * haría una persona: a partir del minuto, y después solo cuando hay algo nuevo que
 * contar (otro paso: «leyendo la web», «mirando tu correo»). Si el mismo paso dura
 * mucho, un recordatorio cada 3 min para que se vea que sigue vivo.
 */

/** Antes de esto el acuse corto («Miro tu correo, dame un momento») basta. */
export const PROGRESS_FIRST_MS = 60_000;
/** Entre dos notas, como poco esto, aunque cambie el paso. */
export const PROGRESS_MIN_GAP_MS = 45_000;
/** Mismo paso todo el rato: una nota cada tanto, no más. */
export const PROGRESS_HEARTBEAT_MS = 180_000;

export class ProgressMilestones {
  #lastAt: number | null = null;
  #shown: string | null = null;

  /** ¿Toca nota ahora? `step` es el paso en curso (null si aún no hay ninguno). */
  due(elapsedMs: number, now: number, step: string | null): boolean {
    if (elapsedMs < PROGRESS_FIRST_MS) return false;
    if (this.#lastAt === null) return true;
    const gap = now - this.#lastAt;
    if (gap < PROGRESS_MIN_GAP_MS) return false;
    return step !== this.#shown || gap >= PROGRESS_HEARTBEAT_MS;
  }

  /** Apunta que la nota se ha mostrado con este paso. */
  shown(now: number, step: string | null): void {
    this.#lastAt = now;
    this.#shown = step;
  }
}
