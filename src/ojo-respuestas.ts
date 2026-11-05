/**
 * Lo que dice el ojo (avisos de Descargas y de la pantalla) sin mandar a «/ojo … on»
 * (Nico, 1 nov: «como estamos hablando nosotros»). La respuesta normal lo enciende.
 */

import { esSiRespuesta } from './daemon/pregunta-pendiente.js';
import { foldAccents } from './text.js';

/** «enciéndelo», «sí», «actívalo»: la respuesta que enciende lo que estaba apagado. */
const ENCIENDE =
  /^(?:s[ií]|vale|venga|dale|enci[eé]nde(?:lo|la)?|act[ií]va(?:lo|la)?|pr[eé]nde(?:lo|la)?)[.!]*$/i;

export function ojoOnAnswer(text: string): boolean {
  // «sí, enciéndelo», «vale, actívalo», «sí porfa»: antes solo valía una palabra suelta.
  return ENCIENDE.test(text.trim()) || esSiRespuesta(text);
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

const APAGA_PALABRAS = new Set([
  'apaga',
  'apagalo',
  'apagala',
  'quitalo',
  'quitala',
  'desactiva',
  'desactivalo',
  'desactivala',
]);
const APAGA_RELLENO = new Set([
  'si',
  'vale',
  'venga',
  'ok',
  'porfa',
  'por',
  'favor',
  'gracias',
  'ya',
]);

export function ojoOffAnswer(text: string): boolean {
  if (APAGA.test(text.trim())) return true;
  // «sí, apágalo», «apágalo porfa», «vale, quítalo»: antes solo valía una palabra suelta.
  const words = foldAccents(text.toLocaleLowerCase('es'))
    .replace(/[¡!¿?.,;:«»"]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 5 &&
    words.some((w) => APAGA_PALABRAS.has(w)) &&
    words.every((w) => APAGA_PALABRAS.has(w) || APAGA_RELLENO.has(w))
  );
}

/** /memoria olvidar sin código: pregunta cuál, sin mandar a «/memoria olvidar …». */
export const MEMORIA_FORGET_ASK =
  '¿Cuál olvido? Dime el código que sale entre corchetes en la lista de lo que recuerdo, por ejemplo «a1b2c3».';

/** «a1b2c3» (o «[a1b2c3]») tras «¿Cuál olvido?» → `olvidar a1b2c3` para /memoria. */
export function memoriaForgetAnswer(text: string): string | null {
  const code = text.replace(/[«»"'[\]]/g, '').trim();
  return /^[a-z0-9][a-z0-9-]{2,39}$/i.test(code) ? `olvidar ${code}` : null;
}

/** Descargas encendido pero sin carpeta que vigilar: pregunta dónde está, sin claves de la bóveda. */
export const DOWNLOADS_DIR_ASK =
  'Si tu carpeta de Descargas está en otro sitio, dime dónde (por ejemplo «D:\\Descargas») y vigilo esa.';

/** «D:\Descargas» o «/home/nico/Descargas» tras esa pregunta → `descargas carpeta …` para /ojo. */
export function downloadsDirAnswer(text: string): string | null {
  const dir = text.replace(/[«»"']/g, '').trim();
  return /^(?:[a-z]:[\\/]|\\\\|\/|~[\\/])\S/i.test(dir) ? `descargas carpeta ${dir}` : null;
}

/** La carpeta que dijo no existe: lo dice y vuelve a preguntar. */
export function downloadsDirMissingText(dir: string): string {
  return `No encuentro la carpeta «${dir.trim()}». ¿Me dices otra vez dónde está, con la ruta entera?`;
}

/** Carpeta guardada: si ya la vigila, cómo se apaga; si no, por qué. */
export function downloadsDirSavedText(
  dir: string,
  st: { running: boolean; reason?: string | undefined } | null,
): string {
  if (!st) return `Hecho, cuando enciendas las Descargas vigilo «${dir}».`;
  if (st.running) return `Hecho, ahora vigilo «${dir}». ${OJO_OFF_HINT}`;
  return `He guardado «${dir}», pero ${st.reason ?? 'no he podido empezar a vigilar'}.`;
}
