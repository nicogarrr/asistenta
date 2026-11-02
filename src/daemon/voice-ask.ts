/**
 * ¿Quiere el usuario la respuesta en voz? Solo si lo pide («en un audio», «con voz»,
 * «contéstame hablando») o dice que va conduciendo. Por defecto se responde con texto,
 * también cuando el usuario mandó una nota de voz.
 */
const PIDE_VOZ: RegExp[] = [
  /\b(en|con|por)\s+(un\s+|una\s+)?(audio|nota\s+de\s+voz|mensaje\s+de\s+voz|voz)\b/i,
  /\b(m[aá]ndame|env[ií]ame|d[ií]melo|cu[eé]ntamelo|cont[eé]stame|resp[oó]ndeme|l[eé]emelo|l[eé]eme)\s+(\S+\s+){0,3}(audio|voz|hablando|en voz alta)\b/i,
  /\b(h[aá]blame|en voz alta)\b/i,
  /\b(estoy|voy|ando|sigo)\s+(conduciendo|manejando|al\s+volante|en\s+el\s+coche|en\s+coche)\b/i,
  /\b(conduzco|manejo)\b/i,
];

const NIEGA_VOZ =
  /\b(sin|no\s+(me\s+)?(mandes|env[ií]es|quiero|contestes|respondas)(\s+\S+){0,2})\s+(audio|voz|nota\s+de\s+voz)\b/i;

export function pideVoz(text: string): boolean {
  const t = text.replace(/\s+/g, ' ');
  if (NIEGA_VOZ.test(t)) return false;
  return PIDE_VOZ.some((re) => re.test(t));
}
