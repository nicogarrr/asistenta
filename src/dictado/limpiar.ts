/**
 * Limpieza del dictado, sin modelo: lo que sale de whisper tal cual se dijo
 * pasa a texto escrito. Quita muletillas («eh», «em», «o sea»), convierte las
 * órdenes dichas en signos («coma», «punto», «punto y aparte», «abre
 * interrogación»…), arregla espacios y pone mayúscula al empezar cada frase.
 *
 * «coma» y «punto» también son palabras normales («que se coma la tarta», «el
 * punto de encuentro»): detrás de un pronombre o de un artículo se dejan como
 * palabra.
 */

const MULETILLAS = /(^|[\s,.;:¿¡])(?:e+h+|e+m+|m{2,}|a+h+|o sea)(?=$|[\s,.;:?!])/giu;

/** Órdenes habladas → signo. Las largas primero, para que «punto y coma» no sea «punto». */
const ORDENES: ReadonlyArray<[RegExp, string]> = [
  [/punto y aparte|nuevo p[aá]rrafo/giu, '\uE000P'],
  [/nueva l[ií]nea|salto de l[ií]nea/giu, '\uE000L'],
  [/punto y seguido/giu, '\uE000.'],
  [/punto y coma/giu, '\uE000;'],
  [/dos puntos/giu, '\uE000:'],
  [/puntos suspensivos/giu, '\uE000…'],
  [/(?:abre|abrir) (?:signo de )?interrogaci[oó]n/giu, '\uE001¿'],
  [/(?:cierra|cerrar) (?:signo de )?interrogaci[oó]n|signo de interrogaci[oó]n/giu, '\uE000?'],
  [/(?:abre|abrir) (?:signo de )?exclamaci[oó]n/giu, '\uE001¡'],
  [/(?:cierra|cerrar) (?:signo de )?exclamaci[oó]n|signo de exclamaci[oó]n/giu, '\uE000!'],
  [/(?:abre|abrir) par[eé]ntesis/giu, '\uE001('],
  [/(?:cierra|cerrar) par[eé]ntesis/giu, '\uE000)'],
];

/** Delante de «coma» la dejan como verbo («que se coma»). */
const ANTES_DE_COMA_VERBO = /(?:^|\s)(?:me|te|se|le|lo|la|nos|os|les|los|las|que|no)$/iu;
/** Delante de «punto» lo dejan como nombre («el punto»). */
const ANTES_DE_PUNTO_NOMBRE =
  /(?:^|\s)(?:el|un|ese|este|aquel|del|al|mi|tu|su|buen|mal|cada|alg[uú]n|ning[uú]n|qu[eé]|otro|primer|[uú]ltimo|mismo)$/iu;

const CIERRAN = ',.;:?!)…';

function ordenesSimples(texto: string): string {
  return texto.replace(
    /(^|[\s,.;:])(coma|punto)(?=$|[\s,.;:?!])/giu,
    (todo, pre, palabra, pos, s) => {
      const antes = s.slice(0, pos + pre.length).replace(/[\s,.;:]+$/u, '');
      const despues = s.slice(pos + todo.length);
      if (palabra.toLowerCase() === 'coma' && ANTES_DE_COMA_VERBO.test(antes)) return todo;
      if (palabra.toLowerCase() === 'punto') {
        if (ANTES_DE_PUNTO_NOMBRE.test(antes)) return todo;
        if (/^\s*(?:de|del|com|es|y\s+final)\b/iu.test(despues)) return todo;
      }
      return `${pre}\uE000${palabra.toLowerCase() === 'coma' ? ',' : '.'}`;
    },
  );
}

/** Deja el texto dictado listo para escribir. Vacío si solo había muletillas. */
export function limpiarDictado(bruto: string): string {
  let t = bruto.replace(/\s+/gu, ' ').trim();
  t = t.replace(MULETILLAS, '$1');
  for (const [re, signo] of ORDENES) t = t.replace(re, signo);
  t = ordenesSimples(t);
  // Signo de cierre dicho: se come la puntuación que whisper puso alrededor.
  t = t.replace(/[\s,.;:]*\uE000(.)[\s,.;:]*/gu, (_m, s: string) => {
    if (s === 'P') return '.\n\n';
    if (s === 'L') return '\n';
    return `${s} `;
  });
  t = t.replace(/\s*\uE001(.)[\s,]*/gu, ' $1');
  // Espacios: nada antes de los que cierran, nada después de los que abren.
  t = t.replace(new RegExp(`[ \\t]+([${CIERRAN}])`, 'gu'), '$1');
  t = t.replace(/([¿¡(])[ \t]+/gu, '$1');
  t = t.replace(/[ \t]*\n[ \t]*/gu, '\n');
  t = t.replace(/,(?=[.;:?!…])/gu, '');
  t = t.replace(/([.;:?!…])[.,]+/gu, '$1');
  t = t.replace(/^[\s,.;:]+/u, '');
  t = t.replace(/[ \t]{2,}/gu, ' ').trim();
  // Mayúscula al empezar y tras fin de frase o salto de línea.
  t = t.replace(
    /(^|[.?!…]\s+|\n)([¿¡(]?)(\p{Ll})/gu,
    (_m, a, b, c: string) => a + b + c.toUpperCase(),
  );
  return t;
}
