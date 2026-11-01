/**
 * Lo que dice Asistenta sobre el micrófono y la conversación por voz sin mandar a
 * «/wake on» ni a «/conversacion off» (Nico, 1 nov: «como estamos hablando nosotros»).
 * La respuesta normal («sí», «apágala») completa el comando.
 */

/** Tras dejar de escuchar por un fallo: «sí» vuelve a encender la escucha. */
export const WAKE_AGAIN_ASK = '¿Vuelvo a escuchar? Dime «sí».';

/** El botón del mando con el micrófono apagado: «sí» lo enciende. */
export const MIC_OFF_TEXT =
  'Has pulsado el botón del mando pero el micrófono está apagado. ¿Lo enciendo? Dime «sí».';

/** Cómo se apaga la conversación por voz, dicho como en un chat. */
export const CONVERSACION_OFF_HINT = 'Si quieres apagarla, dime «apágala».';

const APAGALA =
  /^(?:ap[aá]ga(?:la|lo)?|qu[ií]ta(?:la|lo)|desact[ií]va(?:la|lo)?)(?:\s+la\s+conversaci[oó]n)?[.!]*$/i;

/** «apágala» → `off` para /conversacion; null si la respuesta es otra cosa. */
export function conversacionOffAnswer(text: string): string | null {
  return APAGALA.test(text.trim()) ? 'off' : null;
}

/** /conversacion estado con el micrófono cerrado: «sí» lo abre (como /conversacion on). */
export const MIC_CLOSED_ASK = ' El micrófono está cerrado. ¿Lo abro? Dime «sí».';

/** /conversacion corte sin nivel: cómo está y cómo se cambia, dicho como en un chat. */
export function corteAsk(level: string): string {
  return `Corte al interrumpirme: ${level}. ¿Lo cambio? Dime «con auriculares», «con altavoces» o «sin corte» (vale desde la próxima sesión).`;
}

/** «con auriculares» → `corte auriculares` para /conversacion; null si es otra cosa. */
export function corteAnswer(text: string): string | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  if (/^(?:con\s+(?:los\s+)?)?auriculares$/.test(t)) return 'corte auriculares';
  if (/^(?:con\s+(?:los\s+)?)?altavoces$/.test(t)) return 'corte altavoces';
  if (/^(?:sin\s+corte|que\s+no\s+me\s+cortes|no\s+me\s+cortes|off)$/.test(t)) return 'corte off';
  return null;
}
