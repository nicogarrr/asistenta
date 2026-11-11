/**
 * «📲 .ics (iPhone)» de lo que apunta Asistenta en su calendario local (/calendario add): ese
 * calendario vive en el PC y no llega al móvil; el botón le manda ESE evento en un .ics para
 * abrirlo en el iPhone y tocar «Añadir», sin Google. Solo lee el local.ics.
 */
import { icsNombre } from '../ics.js';

/** Los 20 hex del UID de un evento apuntado por `appendEvent` (botón de /calendario). */
export const LOCAL_UID_HASH = /^[0-9a-f]{20}$/;

const desescapar = (v: string): string =>
  v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/**
 * El evento de ese UID del local.ics, como un .ics suelto (METHOD:PUBLISH), con su nombre de
 * fichero. null si ya no está (lo borró, otro PC…).
 */
export function eventoLocalIcs(
  calendario: string,
  hash: string,
): { ics: string; nombre: string; titulo: string } | null {
  if (!LOCAL_UID_HASH.test(hash)) return null;
  const texto = calendario.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const bloques = texto.match(/BEGIN:VEVENT\n[\s\S]*?\nEND:VEVENT/g) ?? [];
  const uid = `UID:${hash}@asistenta.local`;
  const bloque = bloques.find((b) => b.split('\n').some((l) => l.trim() === uid));
  if (!bloque) return null;
  const titulo = desescapar(/^SUMMARY[^:]*:(.*)$/m.exec(bloque)?.[1]?.trim() ?? '') || 'Evento';
  const ics = `${[
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Asistenta//Calendario//ES',
    'METHOD:PUBLISH',
    'CALSCALE:GREGORIAN',
    ...bloque.split('\n'),
    'END:VCALENDAR',
  ].join('\r\n')}\r\n`;
  return { ics, nombre: icsNombre(titulo), titulo };
}
