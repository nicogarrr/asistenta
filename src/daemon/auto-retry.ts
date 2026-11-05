/**
 * Reintento automático cuando el modelo no contesta por la red o el servicio.
 *
 * Antes, si el PC se quedaba sin internet o el proveedor del modelo estaba caído,
 * el chat decía «Prueba en un momento» y el mensaje se perdía: Nico tenía que
 * acordarse de volver a escribirlo. Ahora el asistente lo apunta y lo vuelve a
 * intentar él solo (1, 2, 5, 10 y 15 min después) y contesta en cuanto vuelve
 * la conexión. Los reintentos que fallan otra vez no escriben nada; solo el
 * último avisa de que lo deja. Un mensaje nuevo en la misma conversación, o
 * /reintentar, cancela el reintento pendiente (manda lo último que dijo el dueño).
 */

/** Esperas entre reintentos: ~33 min en total antes de rendirse. */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [60_000, 120_000, 300_000, 600_000, 900_000];

/** Cuando ya no quedan reintentos. */
export const AUTO_RETRY_GAVE_UP =
  'Sigo sin poder hablar con el modelo, así que dejo de reintentarlo yo solo. Cuando vuelva la conexión, dime /reintentar o escríbemelo otra vez.';

/** «1 min», «15 min» o «30 s». */
export function retryDelayText(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Lo que se añade al aviso del primer fallo. */
export function autoRetryNote(delayMs: number): string {
  return `Lo vuelvo a intentar yo solo en ${retryDelayText(delayMs)} y te contesto aquí en cuanto vuelva (si me escribes otra cosa, lo dejo).`;
}

type Timer = ReturnType<typeof setTimeout>;

export interface AutoRetriesOptions {
  delays?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/**
 * Un reintento pendiente como mucho por conversación. `schedule` devuelve la
 * espera elegida, o null si ya se gastaron todos los intentos (o está apagado).
 */
export class AutoRetries {
  readonly #pending = new Map<string, Timer>();
  readonly #delays: readonly number[];
  readonly #set: (fn: () => void, ms: number) => Timer;
  readonly #clear: (t: Timer) => void;

  constructor(opts: AutoRetriesOptions = {}) {
    this.#delays = opts.delays ?? AUTO_RETRY_DELAYS_MS;
    this.#set =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // Un reintento pendiente nunca impide que el daemon se cierre.
        t.unref?.();
        return t;
      });
    this.#clear = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  /**
   * Programa el intento número `attempt` (0 = el primer reintento tras el fallo
   * original). Sustituye al que hubiera pendiente en esa conversación.
   */
  schedule(key: string, attempt: number, run: () => void | Promise<void>): number | null {
    this.cancel(key);
    const delay = this.#delays[attempt];
    if (delay === undefined || attempt < 0) return null;
    const timer = this.#set(() => {
      if (this.#pending.get(key) !== timer) return;
      this.#pending.delete(key);
      void Promise.resolve()
        .then(run)
        .catch(() => {});
    }, delay);
    this.#pending.set(key, timer);
    return delay;
  }

  /** Quita el reintento pendiente de la conversación. true si había uno. */
  cancel(key: string): boolean {
    const t = this.#pending.get(key);
    if (t === undefined) return false;
    this.#clear(t);
    this.#pending.delete(key);
    return true;
  }

  pending(key: string): boolean {
    return this.#pending.has(key);
  }

  get size(): number {
    return this.#pending.size;
  }

  stopAll(): void {
    for (const t of this.#pending.values()) this.#clear(t);
    this.#pending.clear();
  }
}
