/**
 * Piezas del manejo de mensajes entrantes del daemon (antes dentro de
 * serveCommand en cli.ts). Movidas tal cual, sin cambio de comportamiento:
 * cli.ts las usa y el arnés e2e (test/helpers/e2e-core.ts) importa las mismas.
 */

/** Telegram entrega al menos una vez: un update repetido dentro de esta ventana se ignora. */
export const SEEN_MESSAGE_TTL_MS = 3_600_000;
/** Tope de ids recordados; al pasarlo se olvida el más antiguo. */
export const SEEN_MESSAGE_MAX = 2000;

/**
 * ¿Es `key` (`<chatKey>:<messageId>`) un update ya visto hace menos de una hora?
 * Si no lo es, queda apuntado (y se olvida el más antiguo al pasar el tope).
 */
export function isDuplicateUpdate(
  seen: Map<string, number>,
  key: string,
  now: number = Date.now(),
): boolean {
  const seenAt = seen.get(key);
  if (seenAt !== undefined && now - seenAt < SEEN_MESSAGE_TTL_MS) return true;
  seen.set(key, now);
  if (seen.size > SEEN_MESSAGE_MAX) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** Lo mínimo de un hilo para encolar turnos: su cola y su generación (/stop la sube). */
export interface QueueableThread {
  tail: Promise<unknown>;
  generation: number;
}

/**
 * Encola `work` detrás de lo que ya corre en el hilo. Hilos distintos corren a la
 * vez; dentro de un hilo, en orden. Si /stop sube la generación antes de que le
 * toque, el trabajo no corre (devuelve undefined). Un fallo no rompe la cola.
 */
export function queueThreadTurn<T>(
  thread: QueueableThread,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const gen = thread.generation;
  const next = thread.tail.then(async () => {
    if (thread.generation !== gen) return undefined;
    return work();
  });
  thread.tail = next.catch(() => {});
  return next;
}
