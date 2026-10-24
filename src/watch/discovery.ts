/**
 * Descubrimiento de términos de búsqueda a partir de tarjetas ya leídas (capa A).
 * Los títulos son DATOS externos no confiables: solo se usan para contar palabras sueltas
 * alfabéticas; nunca se interpretan como instrucciones ni se guardan textos largos.
 * Esto solo AMPLÍA qué se lee (con tope y retención); no baja umbrales ni crea alarmas.
 */

export const MAX_DISCOVERED_TERMS = 12;
export const MAX_NEW_TERMS_PER_RUN = 2;
/** Un término que no vuelve a aparecer en tarjetas durante este tiempo se retira. */
export const TERM_RETENTION_MS = 14 * 24 * 3600 * 1000;
/** Mínimo de tarjetas distintas de una misma página donde debe aparecer el par de palabras. */
export const MIN_CARDS_PER_TERM = 3;
export const MAX_OBSERVATIONS = 2000;
export const MAX_OBSERVATIONS_PER_RUN = 60;

const STOP = new Set(
  'para con sin los las del una uno unos unas por que más mas muy pro max plus mini new nuevo nueva pack gb tb pulgadas color negro blanco gris azul rojo plata versión version modelo oferta amazon'.split(
    ' ',
  ),
);

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Pares de palabras alfabéticas (3-14 letras, sin stopwords) de un título, sin repetir. */
export function wordPairs(title: string): string[] {
  const toks = norm(title.slice(0, 200))
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3 && t.length <= 14 && !STOP.has(t));
  const out = new Set<string>();
  for (let i = 0; i + 1 < toks.length && i < 6; i++) out.add(`${toks[i]} ${toks[i + 1]}`);
  return [...out];
}

/**
 * Pares presentes en >= MIN_CARDS_PER_TERM tarjetas de la misma página y aún desconocidos.
 * `isBad` descarta accesorios/reacondicionados (misma regla que el barrido). Orden estable.
 */
export function candidateTerms(
  titles: string[],
  known: Set<string>,
  isBad: (title: string) => boolean,
): string[] {
  const counts = new Map<string, number>();
  for (const t of titles) {
    if (isBad(t)) continue;
    for (const p of wordPairs(t)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([p, n]) => n >= MIN_CARDS_PER_TERM && !known.has(p) && !isBad(p))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p]) => p);
}
