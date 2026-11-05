/**
 * Aviso de «estoy con otra cosa» para un mensaje que se queda en cola.
 *
 * Antes, con una tarea larga en marcha, un mensaje nuevo se quedaba esperando en la cola
 * del hilo sin ninguna señal: Nico no sabía si se había leído ni cuándo iba a tocarle.
 * Ahora, si lo que corre lleva ya un rato, se le dice una vez por tarea que va justo
 * después y que una pregunta rápida tiene /btw (src/btw.ts), que contesta al momento.
 *
 * Una vez por tarea en marcha: la segunda y la tercera línea seguidas no repiten el aviso.
 */

/** Lo que tiene que llevar en marcha la tarea para que avisar tenga sentido. */
export const BUSY_NOTE_AFTER_MS = 20_000;

export const BUSY_NOTE =
  '⏳ Sigo con lo anterior; esto va justo después. Si es una pregunta rápida, escríbeme /btw y la pregunta y te contesto ya.';

export interface BusyThread {
  active: boolean;
  /** Cuándo empezó la tarea en marcha (ms). */
  activeSince?: number;
  /** `activeSince` de la tarea por la que ya se avisó. */
  busyNoted?: number;
}

/** El aviso si toca (y lo marca como dado), o null. */
export function busyNoteFor(thread: BusyThread, now: number): string | null {
  if (!thread.active || thread.activeSince === undefined) return null;
  if (now - thread.activeSince < BUSY_NOTE_AFTER_MS) return null;
  if (thread.busyNoted === thread.activeSince) return null;
  thread.busyNoted = thread.activeSince;
  return BUSY_NOTE;
}
