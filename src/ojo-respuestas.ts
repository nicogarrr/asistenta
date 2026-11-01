/**
 * Lo que dice el ojo (avisos de Descargas y de la pantalla) sin mandar a «/ojo … on»
 * (Nico, 1 nov: «como estamos hablando nosotros»). La respuesta normal lo enciende.
 */

/** «enciéndelo», «sí», «actívalo»: la respuesta que enciende lo que estaba apagado. */
const ENCIENDE =
  /^(?:s[ií]|vale|venga|dale|enci[eé]nde(?:lo|la)?|act[ií]va(?:lo|la)?|pr[eé]nde(?:lo|la)?)[.!]*$/i;

export function ojoOnAnswer(text: string): boolean {
  return ENCIENDE.test(text.trim());
}

export const DOWNLOADS_OFF_TEXT =
  'Descargas: apagado (es lo normal). Si quieres que te avise de lo que te bajes, dime «enciéndelo».';

export const SCREEN_OFF_TEXT =
  'Pantalla: apagado (es lo normal). Si quieres que la mire en cada barrido, dime «enciéndelo».';

/** El ejemplo de la investigación amplia, dicho como se escribe en el chat. */
export const WIDE_EXAMPLE = '«precio y garantía | iPhone 16, Pixel 9, Galaxy S25»';
