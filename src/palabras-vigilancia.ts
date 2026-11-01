/**
 * Vigilancias de precio y /evolucion dichas como en un chat, sin mandar a «/vigilando»,
 * «/dejar_de_vigilar» ni «/evolucion …» (Nico, 1 nov: «como estamos hablando nosotros»).
 */

/** Tras crear una vigilancia de precio: cómo se quita, en palabras. */
export const PRICE_WATCH_REMOVE_HINT =
  'Si un día quieres quitarla, dime «deja de vigilar» y te pregunto cuál.';

/**
 * «deja de vigilar», «para de vigilar la tele», «ya no vigiles el iPhone» → lo que va detrás
 * ('' si nada); otra cosa → null.
 */
export function stopWatchingWords(text: string): string | null {
  const m =
    /^(?:(?:deja|para)\s+de\s+vigilar|ya\s+no\s+vigiles)(?:\s+(?:la|el|lo|los|las)?\s*(.+?))?[.!]*$/i.exec(
      text.trim(),
    );
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/** El pie del estado de /evolucion: cómo se pide una idea o un ciclo, sin comandos. */
export const EVOLVE_HOW =
  'Nada entra sin pasar por PR y auditoría. Si quieres que aprenda algo, pídemelo (por ejemplo «aprende a resumir mis correos»); si quieres que pruebe ya, dime «prueba ahora».';

/** «prueba ahora», «lánzalo ya»: la respuesta que lanza un ciclo tras el estado de /evolucion. */
export function evolveNowAnswer(text: string): boolean {
  return /^(?:pru[eé]ba(?:lo)?|l[aá]nza(?:lo)?|hazlo|empieza)\s+(?:ahora|ya)[.!]*$/i.test(
    text.trim(),
  );
}
