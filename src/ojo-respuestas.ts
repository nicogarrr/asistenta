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

/** Con el ojo de Descargas o de Pantalla encendido: cómo se apaga, dicho como en un chat. */
export const OJO_OFF_HINT = 'Si quieres que lo apague, dime «apágalo».';

const APAGA = /^(?:ap[aá]ga(?:lo|la)?|qu[ií]ta(?:lo|la)|desact[ií]va(?:lo|la)?)[.!]*$/i;

export function ojoOffAnswer(text: string): boolean {
  return APAGA.test(text.trim());
}

/** /memoria olvidar sin código: pregunta cuál, sin mandar a «/memoria olvidar …». */
export const MEMORIA_FORGET_ASK =
  '¿Cuál olvido? Dime el código que sale entre corchetes en la lista de lo que recuerdo, por ejemplo «a1b2c3».';

/** «a1b2c3» (o «[a1b2c3]») tras «¿Cuál olvido?» → `olvidar a1b2c3` para /memoria. */
export function memoriaForgetAnswer(text: string): string | null {
  const code = text.replace(/[«»"'[\]]/g, '').trim();
  return /^[a-z0-9][a-z0-9-]{2,39}$/i.test(code) ? `olvidar ${code}` : null;
}
