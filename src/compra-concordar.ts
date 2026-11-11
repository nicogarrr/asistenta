/**
 * Concordancia de un ingrediente con su cantidad nueva: al escalar una receta o sumar a la
 * lista, «1 cebolla» pasaba a «2 cebolla» y «2 huevos» a «1 huevos». Solo se tocan las
 * palabras del principio (el nombre y sus adjetivos), hasta «de», «con», una coma…:
 * «1 diente de ajo» → «2 dientes de ajo», «1 cebolla grande, picada» → «2 cebollas grandes,
 * picada». Las unidades abreviadas («g», «cda», «kg») no cambian.
 */

const PARA = new Set([
  'de',
  'del',
  'con',
  'para',
  'sin',
  'y',
  'e',
  'o',
  'u',
  'en',
  'a',
  'al',
  'por',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'muy',
  'mas',
  'más',
]);
const ABREV = new Set([
  'g',
  'gr',
  'grs',
  'kg',
  'mg',
  'ml',
  'cl',
  'dl',
  'l',
  'lt',
  'cda',
  'cdas',
  'cdta',
  'cdtas',
  'cc',
  'ud',
  'uds',
  'u',
  'oz',
  'lb',
  'tbsp',
  'tsp',
]);
const SIN_TILDE: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };
const CON_TILDE: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' };

function plural(w: string): string {
  if (/s$|x$/i.test(w)) return w;
  if (/z$/i.test(w)) return `${w.slice(0, -1)}ces`;
  // «limón» → «limones», «calabacín» → «calabacines»: la tilde se va.
  const tilde = /([áéíóú])([ns])$/i.exec(w);
  if (tilde?.[1] && tilde[2])
    return `${w.slice(0, -2)}${SIN_TILDE[tilde[1].toLowerCase()] ?? tilde[1]}${tilde[2]}es`;
  if (/[aeiouáéó]$/i.test(w)) return `${w}s`;
  if (/[lnrdj]$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

function singular(w: string): string {
  if (!/s$/i.test(w) || w.length <= 3) return w;
  if (/[aeiou]ces$/i.test(w)) return `${w.slice(0, -3)}z`;
  // «limones» → «limón», «calabacines» → «calabacín», «atunes» → «atún».
  const tilde = /([oiu])nes$/i.exec(w);
  if (tilde?.[1] && w.length > 5)
    return `${w.slice(0, -4)}${CON_TILDE[tilde[1].toLowerCase()] ?? tilde[1]}n`;
  // «naturales» → «natural», «yogures» → «yogur», «panes» → «pan» (vocal antes; no
  // «sobres» → «sobr» ni «grandes» → «grand»).
  if (/[aeiou][lnr]es$/i.test(w)) return w.slice(0, -2);
  return w.slice(0, -1);
}

/** El resto de la línea tras el número, con el nombre en plural (o en singular). */
export function concordar(rest: string, enPlural: boolean): string {
  const parts = rest.split(/(\s+)/);
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i] ?? '';
    if (!tok || /^\s+$/.test(tok)) continue;
    // «grande,» o «(picada)»: hasta ahí; la palabra con la coma pegada sí cuenta.
    const m = /^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)(.*)$/.exec(tok);
    if (!m?.[1]) break;
    const word = m[1];
    const low = word.toLowerCase();
    if (PARA.has(low)) break;
    if (!ABREV.has(low) && word.length >= 3 && word !== word.toUpperCase())
      parts[i] = `${enPlural ? plural(word) : singular(word)}${m[2] ?? ''}`;
    if (m[2]) break;
  }
  return parts.join('');
}

/** ¿«1» o «0,5» (singular) o más de uno (plural)? */
export function esPlural(q: number): boolean {
  return q > 1 + 1e-9;
}
