/**
 * Lo que dice la vista en directo (/screen live, /camera on) sin mandar a «/screen off»
 * (Nico, 1 nov: «como estamos hablando nosotros»). Mientras hay una vista abierta en el
 * chat, un «para» normal la para.
 */

/** «para», «párala», «apágala», «basta»: lo que se dice para cortar la vista. */
const PARA =
  /^(?:para|p[aá]ra(?:la|lo)|ap[aá]ga(?:la|lo)|qu[ií]ta(?:la|lo)|basta|stop|deja de mirar)(?:\s+(?:la vista|el directo|la c[aá]mara|la pantalla|ya))?[.!]*$/i;

export function liveStopAnswer(text: string): boolean {
  return PARA.test(text.trim());
}

export function liveCaption(source: 'screen' | 'camera'): string {
  return source === 'camera'
    ? 'Cámara en directo, se actualiza sola. Cuando quieras que la pare, dime «para».'
    : 'Pantalla en directo, se actualiza sola. Cuando quieras que la pare, dime «para».';
}

export const LIVE_BUSY_TEXT = 'Ya hay una vista en directo. Si quieres que la pare, dime «para».';

export const LIVE_STOPPED_TEXT = 'Vista en directo parada.';
