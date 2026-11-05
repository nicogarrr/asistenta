import { esSiCalendario } from './calendario-pasado.js';
import { parseFechaCalendario } from './fecha-natural.js';

/**
 * Respuesta a «Eso ya ha pasado (…). ¿Lo apunto igualmente? Dime «sí», o dime otra
 * fecha.» de /calendario. Devuelve la orden de /calendario que toca, o null si la
 * respuesta no es ni un sí ni otra fecha (entonces la lee el modelo como siempre).
 *
 * Antes «otra fecha» solo valía repitiendo también el título («mañana a las 10
 * dentista»): lo normal, «mañana a las 10» o «no, mejor el viernes a las 10», no era
 * una fecha válida (le faltaba el título) y caía al modelo, que no sabía qué evento era.
 */
export function respuestaCalendarioPasado(
  text: string,
  start: Date,
  title: string,
  now: Date = new Date(),
  timeZone?: string,
): string | null {
  if (esSiCalendario(text)) return `confirmado ${start.toISOString()} | ${title}`;
  // «no, mejor…», «pues el viernes…», «vale, mañana…»: el arranque no es parte de la fecha.
  const limpio = text
    .trim()
    .replace(
      /^(?:(?:s[ií]|no|vale|mejor|pues|entonces|pero|venga|ok|ap[uú]ntalo|ponlo|para)(?=[\s,.;:!]|$)[\s,.;:!]*)+/i,
      '',
    )
    .trim();
  if (!limpio) return null;
  // Solo la fecha: el mismo evento en la fecha nueva.
  const mismo = parseFechaCalendario(`${limpio} ${title}`, now, timeZone);
  if (mismo && mismo.title === title) return `add ${limpio} ${title}`;
  // La fecha con otro título («mañana a las 10 cena»): como antes.
  return parseFechaCalendario(limpio, now, timeZone) ? `add ${limpio}` : null;
}
