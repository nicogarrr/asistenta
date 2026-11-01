/**
 * Un tick de objetivo encolado que no llega a empezar porque Nico paró el chat (el contador de
 * generación del hilo solo sube al pararlo). Antes salía como «parado con /stop» y el aviso lo
 * convertía en «fallo interno»; ahora se dice en palabras y sin nombrar comandos.
 */
export const GOAL_TICK_STOPPED = 'lo paraste tú antes de que empezara';

/** El aviso del objetivo cuando el intento no empezó porque se paró el chat. */
export function goalStoppedText(title: string): string {
  return `🎯 "${title}": esta vez no lo he avanzado porque paraste el chat antes de que empezara. Sigo en el siguiente intento.`;
}
