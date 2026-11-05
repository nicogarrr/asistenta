/**
 * Aviso de «estoy con otra cosa» para un mensaje que se queda en cola.
 *
 * Antes, con una tarea larga en marcha, un mensaje nuevo se quedaba esperando en la cola
 * del hilo sin ninguna señal: Nico no sabía si se había leído ni cuándo iba a tocarle.
 * Ahora, si lo que corre lleva ya un rato, se le dice una vez por tarea que va justo
 * después y que una pregunta rápida tiene /btw (src/btw.ts), que contesta al momento.
 *
 * Una vez por tarea en marcha: la segunda y la tercera línea seguidas no repiten el aviso.
 *
 * El aviso lleva un botón «⏹ Pararlo» (/stop <ficha>): corta SOLO la tarea por la que se
 * avisó y el mensaje en cola va a continuación. /stop a secas lo para todo y vacía la
 * cola; el botón no, porque quien lo pulsa acaba de pedir otra cosa. Si esa tarea ya
 * terminó (botón viejo), no para nada.
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

export const BUSY_STOP_LABEL = '⏹ Pararlo';

/** Ficha de la tarea en marcha para el botón «Pararlo»: «tk» + activeSince en base 36. */
export function busyStopToken(thread: BusyThread): string | undefined {
  return thread.activeSince === undefined ? undefined : `tk${thread.activeSince.toString(36)}`;
}

/** ¿Es `/stop <arg>` el del botón «Pararlo»? */
export function isBusyStopToken(arg: string): boolean {
  return /^tk[0-9a-z]{1,12}$/.test(arg);
}

/** El hilo (de este chat) cuya tarea en marcha es la de la ficha, o undefined. */
export function busyThreadForToken<T extends BusyThread & { chatKey: string }>(
  threads: Iterable<T>,
  chatKey: string,
  token: string,
): T | undefined {
  for (const t of threads) {
    if (t.chatKey === chatKey && t.active && busyStopToken(t) === token) return t;
  }
  return undefined;
}

export const BUSY_STOPPED = '⏹ Parado. Voy con tu mensaje.';
export const BUSY_STOP_GONE = 'Eso ya había terminado; no he parado nada.';
