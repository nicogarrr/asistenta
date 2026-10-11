/** Parsing del protocolo del bot Biblioteca Secreta (espec real, capturas 11-oct-2026).
 *
 * Busqueda: texto libre -> lista "Titulo /bCODE" (codigo = /b + 4-5 alfanum (longitud variable, visto en capturas reales)).
 * La pareja titulo/codigo puede partirse en dos lineas ("...Wellesley /\nbdU7y2").
 * Ficha: "Titulo - Autor" + "Publicado: 1994 | 386 paginas" + genero + cita.
 * Botones inline: Informacion / Leer online / Epub / Reportar error.
 * Paginacion: botones ⏮ ◀ ▶ ⏭.
 * Nada de esto inventa datos: si una pieza no esta, sale undefined, nunca "".
 */

export interface BookHit {
  title: string;
  code: string; // sin la barra, p.ej. "bnv7E"
}

export interface BookCard {
  title: string;
  author?: string;
  year?: number;
  pages?: number;
  genre?: string;
}

export const EPUB_BUTTON = 'Epub';
export const PAGINATION_BUTTONS = ['⏮', '◀', '▶', '⏭'] as const;

const CODE_RE = /\/(b[A-Za-z0-9]{4,5})(?![A-Za-z0-9])/g;

/** Extrae pares titulo/codigo tolerando que Telegram parta la pareja en dos
 * lineas dejando la barra con el titulo y el codigo desnudo en la siguiente
 * ("...Wellesley /\nbdU7y2"). */
export function parseSearchResults(text: string): BookHit[] {
  const normalized = text.replace(/\/\s*\n\s*(b[A-Za-z0-9]{4,5})(?![A-Za-z0-9])/g, '/$1');
  const hits: BookHit[] = [];
  for (const match of normalized.matchAll(CODE_RE)) {
    const code = match[1];
    if (!code) continue;
    const before = normalized.slice(0, match.index);
    // El titulo es lo ultimo no vacio antes del codigo; puede terminar en "/"
    // suelto si el salto de linea cayo justo ahi.
    const tail = before.replace(/\/\s*$/, '');
    const nl = tail.lastIndexOf('\n');
    const title = tail.slice(nl + 1).trim();
    if (title) hits.push({ title, code });
  }
  return hits;
}

const PUBLISHED_RE = /Publicado:\s*(\d{4})\s*\|\s*(\d+)\s*p[áa]ginas/i;

/** Parsea la ficha: primera linea "Titulo - Autor", luego Publicado y genero. */
export function parseBookCard(text: string): BookCard {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const dash = first.lastIndexOf(' - ');
  const card: BookCard = {
    title: (dash > 0 ? first.slice(0, dash) : first).trim(),
  };
  if (dash > 0) card.author = first.slice(dash + 3).trim();
  const pub = text.match(PUBLISHED_RE);
  if (pub) {
    card.year = Number(pub[1]);
    card.pages = Number(pub[2]);
  }
  const pubIdx = lines.findIndex((l) => PUBLISHED_RE.test(l));
  const genreLine = pubIdx >= 0 ? lines[pubIdx + 1] : undefined;
  if (genreLine && !genreLine.startsWith('«')) {
    card.genre = genreLine;
  }
  return card;
}

/** El texto de busqueda que pide el usuario, saneado (sin comandos ni exceso). */
export function sanitizeQuery(input: string): string {
  const clean = input
    .replace(/^\/\S+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) throw new Error('busqueda vacia');
  return clean.slice(0, 120);
}
