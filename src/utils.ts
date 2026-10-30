/**
 * Shared pure helpers with no dependencies, so any module can import them without
 * creating cycles.
 */

/**
 * Stable stringify for fingerprints and comparisons. Key order must not matter:
 * the same action with keys in a different order is still the same action.
 * (Unlike `JSON.stringify` with a replacer array, nested keys are never dropped.)
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/** Run a promise with a wall-clock ceiling. Rejects with `Error(message)` on timeout. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * FIFO async mutex.
 *
 * Needed because the machine is shared state with exactly one mouse, one keyboard
 * and one screen. Serialising whole turns (the previous design) also worked, but it
 * made the agent answer one message at a time, which is precisely what a user does
 * not want when they drop three unrelated things and expect three answers. Holding
 * the lock only for the duration of a desktop tool call lets three conversations
 * think at once and still guarantees that no two of them ever touch the mouse
 * simultaneously.
 *
 * Strictly FIFO on purpose: a later caller that arrived later should not jump the
 * queue, or a long browser task would starve a quick click forever.
 */
function abortError(): Error {
  const err = new Error('operación cancelada');
  err.name = 'AbortError';
  return err;
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  /** Callers currently waiting for the lock, excluding the holder. */
  get queueLength(): number {
    return this.#pending;
  }

  /**
   * signal cancela la ESPERA (no solo la acción): si el usuario pulsa /stop
   * mientras este tool espera el turno de la máquina, no debe ejecutarse cuando
   * por fin le toque. La acción en curso no se interrumpe aquí: para eso está el
   * signal que ya recibe el propio tool.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#pending++;
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = false;
    try {
      if (signal) {
        if (signal.aborted) throw abortError();
        await Promise.race([previous, abortRejection(signal)]);
        if (signal.aborted) throw abortError();
      } else {
        await previous;
      }
      acquired = true;
      return await fn();
    } finally {
      this.#pending--;
      // A waiter cancelled before its turn must not hand its slot on early: the
      // caller queued behind it would start while the current holder is still
      // using the mouse. Pass the slot on only once everything ahead has finished.
      if (acquired) release();
      else void previous.then(release);
    }
  }
}

/**
 * Text the agent stored earlier (a memory fact, a session summary, a
 * workstream field, a routine name) is rendered back inside the fenced blocks
 * of the per-turn context note (<memory>, <historial>, <workstreams>,
 * <routines>). That text can ultimately come from a web page or a tool result
 * the model relayed, and a value containing the closing tag would break out of
 * its fence and pose as prompt markup - the same threat skillsIndex already
 * neutralises for <skills>. This strips exactly the markup-significant
 * characters and nothing else, at render time only: storage is never
 * rewritten, and ordinary punctuation (which can be the point of a fact) is
 * preserved.
 */
export function plainInline(text: string): string {
  return text.replace(/[<>`]/g, ' ');
}
