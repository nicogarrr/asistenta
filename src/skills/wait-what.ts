/**
 * «No te he entendido»: adaptación de wait-what de Matt Pocock
 * (https://github.com/mattpocock/skills, MIT, Copyright (c) 2026 Matt Pocock), con
 * redacción propia. Si el dueño dice «no te entiendo», «¿cómo?» o «explícamelo más
 * fácil» justo después de una respuesta, el código lo reconoce y el turno normal recibe
 * una instrucción fija: volver a explicarlo con contexto y en castellano llano.
 */

const REPITCH =
  /^(?:¿\s*)?(?:c[oó]mo|qu[eé]|eh|perd[oó]n)\s*\?+$|^no\s+(?:te\s+)?(?:he\s+)?(?:entiendo|entendido|pillo|pillado|me\s+entero|me\s+he\s+enterado)\b|^no\s+(?:lo\s+)?(?:entiendo|pillo)\b|^expl[ií]ca(?:me)?lo\s+(?:mejor|m[aá]s\s+(?:f[aá]cil|claro|sencillo)|de\s+otra\s+(?:forma|manera)|en\s+cristiano|como\s+si)|^(?:en\s+cristiano|m[aá]s\s+(?:claro|f[aá]cil|sencillo))\b/i;

/** ¿Pide que le vuelva a explicar lo último? Solo mensajes cortos. */
export function wantsRepitch(raw: string): boolean {
  const text = raw
    .trim()
    .replace(/^(?:uf+|uy|perdona|oye|asistenta)[,\s]+/i, '')
    .replace(/[.!\s]+$/, '');
  if (!text || text.length > 60) return false;
  return REPITCH.test(text);
}

export const REPITCH_INSTRUCTION =
  'No he entendido tu último mensaje. Vuelve a explicármelo de otra forma: primero, en una frase, ' +
  'de qué estábamos hablando; luego lo importante con palabras sencillas, sin jerga, siglas ni nombres ' +
  'técnicos, en frases cortas y como mucho 5 líneas. No lo repitas igual ni añadas cosas nuevas.';

/** Lo que recibe el modelo en lugar del «¿cómo?» suelto. */
export function repitchText(raw: string): string {
  return `${REPITCH_INSTRUCTION}\n\n(Nico escribió: «${raw.trim()}»)`;
}
