/**
 * ¿Quiere el usuario la respuesta en voz? Solo si lo pide («en un audio», «con voz»,
 * «contéstame hablando») o dice que va conduciendo. Por defecto se responde con texto,
 * también cuando el usuario mandó una nota de voz.
 */
const PIDE_VOZ: RegExp[] = [
  // «en un audio», «en una nota de voz», «por mensaje de voz»; «en audio» / «con voz» solo
  // al final («explícamelo en audio», «contesta con voz»). Antes cualquier «con voz» o «por
  // voz» valía: «una canción con voz femenina», «¿controlas la tele por voz?» o «un vídeo
  // con audio» se contestaban con un audio.
  /\b(en|por)\s+(un|una)\s+(audio|nota\s+de\s+voz|mensaje\s+de\s+voz)\b/i,
  /\b(en|por)\s+(nota|mensaje)\s+de\s+voz\b/i,
  /\b(en\s+audio|con\s+voz)\s*[.!?¡¿)]*\s*$/i,
  /\b(m[aá]ndame|env[ií]ame|d[ií]melo|cu[eé]ntamelo|cont[eé]stame|resp[oó]ndeme|l[eé]emelo|l[eé]eme)\s+(\S+\s+){0,3}(audio|voz|hablando|en voz alta)\b/i,
  // «háblame» sí; «háblame de Roma» o «háblame sobre el plan» es «cuéntame», no voz.
  /\bh[aá]blame\b(?!\s+(de|del|sobre|acerca|un\s+poco\s+(de|del|sobre))\b)/i,
  /\ben voz alta\b/i,
  /\b(estoy|voy|ando|sigo)\s+(conduciendo|al\s+volante|en\s+el\s+coche|en\s+coche)\b/i,
  // «manejo» / «conduzco» / «estoy manejando» solos o con «ahora», «ya»…; con complemento
  // («yo manejo las cuentas», «conduzco un Seat», «estoy manejando el Excel») no es conducir.
  /\b(conduzco|manejo|(estoy|voy|ando|sigo)\s+manejando)(?=\s*($|[.,;:!?)]|(ahora|ya|ahorita|en\s+breve|en\s+un\s+rato)\b))/i,
];

const NIEGA_VOZ =
  /\b(sin|no\s+(me\s+)?(mandes|env[ií]es|quiero|contestes|respondas)(\s+\S+){0,2})\s+(audio|voz|nota\s+de\s+voz)\b/i;

export function pideVoz(text: string): boolean {
  const t = text.replace(/\s+/g, ' ');
  if (NIEGA_VOZ.test(t)) return false;
  return PIDE_VOZ.some((re) => re.test(t));
}
