/**
 * La nota de Goodreads de un libro (Nico, 11 nov: «los libros que te vaya pasando, los
 * vas comparando con Goodreads»). Página pública de búsqueda, sin sesión ni API; Open
 * Library (API abierta) para los datos del libro (autor, año, páginas, descripción).
 *
 * Nunca se inventa una nota: si Goodreads no contesta, bloquea o no encuentra el
 * libro, sale «N/D» con el motivo.
 */
import type { Goodreads } from './store.js';

/** Descarga el HTML/JSON crudo de una URL pública (fetchPage en el daemon; falso en tests). */
export type FetchRaw = (url: string, opts?: { userAgent?: string }) => Promise<string>;

const GR = 'https://www.goodreads.com';

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function stripTags(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** «1,126,819» / «1.126.819» → 1126819. */
function intOf(s: string): number {
  return Number(s.replace(/[^\d]/g, ''));
}

export interface GoodreadsHit {
  title: string;
  author: string;
  rating: number;
  ratings: number;
  url: string;
}

/** Primer resultado de la página de búsqueda de Goodreads, o null si no hay. */
export function parseGoodreadsSearch(html: string): GoodreadsHit | null {
  const start = html.indexOf('<tr itemscope');
  if (start < 0) return null;
  const end = html.indexOf('</tr>', start);
  const row = html.slice(start, end > start ? end : start + 20_000);
  const href = /<a class="bookTitle"[^>]*href="([^"]+)"/.exec(row)?.[1];
  const titleHtml = /<a class="bookTitle"[^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1] ?? '';
  const author = /<a class="authorName"[^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1] ?? '';
  const at = row.indexOf('minirating');
  const text = stripTags(
    row.slice(at < 0 ? 0 : at + 'minirating">'.length, (at < 0 ? 0 : at) + 1500),
  );
  const avg = /(\d[.,]\d{1,2})\s*avg rating/i.exec(text)?.[1];
  const count = /([\d.,]+)\s*ratings?/i.exec(text.replace(/^.*avg rating\s*—?\s*/i, ''))?.[1];
  if (!href || !avg) return null;
  const path = decode(href).split('?')[0] ?? '';
  return {
    title: stripTags(titleHtml),
    author: stripTags(author),
    rating: Number(avg.replace(',', '.')),
    ratings: count ? intOf(count) : 0,
    url: path.startsWith('http') ? path : `${GR}${path}`,
  };
}

/** Nota de la ficha de un libro de Goodreads (enlace /book/show/…), por sus metadatos. */
export function parseGoodreadsBook(html: string, url: string): GoodreadsHit | null {
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!ld) return null;
  try {
    const d = JSON.parse(ld) as {
      name?: string;
      author?: Array<{ name?: string }> | { name?: string };
      aggregateRating?: { ratingValue?: number | string; ratingCount?: number | string };
    };
    const r = d.aggregateRating;
    if (!r?.ratingValue) return null;
    const author = Array.isArray(d.author) ? d.author[0]?.name : d.author?.name;
    return {
      title: decode(d.name ?? ''),
      author: decode(author ?? ''),
      rating: Number(String(r.ratingValue).replace(',', '.')),
      ratings: intOf(String(r.ratingCount ?? '0')),
      url: url.split('?')[0] ?? url,
    };
  } catch {
    return null;
  }
}

/** Busca el libro en Goodreads. `bookUrl`: si Nico mandó ya la ficha. */
export async function goodreadsLookup(
  fetchRaw: FetchRaw,
  query: string,
  bookUrl?: string,
): Promise<Goodreads & { title?: string; author?: string }> {
  let html: string;
  const url = bookUrl ?? `${GR}/search?q=${encodeURIComponent(query)}`;
  try {
    html = await fetchRaw(url);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    const reason = /\b(403|429|503)\b/.test(msg)
      ? 'Goodreads bloqueó la consulta'
      : /timed out|abort/i.test(msg)
        ? 'Goodreads no contestó a tiempo'
        : 'no pude abrir Goodreads';
    return { ok: false, reason };
  }
  if (
    /captcha|are you a robot|unusual traffic|awswaf|challenge\.js/i.test(html) &&
    !html.includes('bookTitle')
  )
    return { ok: false, reason: 'Goodreads bloqueó la consulta (verificación anti-bots)' };
  const hit = bookUrl ? parseGoodreadsBook(html, bookUrl) : parseGoodreadsSearch(html);
  if (!hit)
    return {
      ok: false,
      reason: bookUrl ? 'la ficha no trae nota' : 'no encontré el libro en Goodreads',
    };
  return {
    ok: true,
    rating: hit.rating,
    ratings: hit.ratings,
    url: hit.url,
    title: hit.title,
    author: hit.author,
  };
}

export interface OpenLibraryBook {
  title: string;
  /** Nota pública de Open Library (lectores de openlibrary.org), si tiene. */
  rating?: number;
  ratings?: number;
  author?: string;
  year?: number;
  pages?: number;
  description?: string;
  url?: string;
}

/** Datos del libro en Open Library (búsqueda + descripción de la obra). null si no está. */
export async function openLibraryLookup(
  fetchRaw: FetchRaw,
  query: string,
): Promise<OpenLibraryBook | null> {
  try {
    const raw = await fetchRaw(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=1&fields=key,title,author_name,first_publish_year,number_of_pages_median,ratings_average,ratings_count`,
    );
    const d = JSON.parse(raw) as {
      docs?: Array<{
        key?: string;
        title?: string;
        author_name?: string[];
        first_publish_year?: number;
        number_of_pages_median?: number;
        ratings_average?: number;
        ratings_count?: number;
      }>;
    };
    const doc = d.docs?.[0];
    if (!doc?.title) return null;
    const out: OpenLibraryBook = {
      title: doc.title,
      ...(doc.author_name?.[0] ? { author: doc.author_name[0] } : {}),
      ...(doc.first_publish_year ? { year: doc.first_publish_year } : {}),
      ...(doc.number_of_pages_median ? { pages: doc.number_of_pages_median } : {}),
      ...(doc.key ? { url: `https://openlibrary.org${doc.key}` } : {}),
      ...(doc.ratings_average && doc.ratings_count
        ? { rating: doc.ratings_average, ratings: doc.ratings_count }
        : {}),
    };
    if (doc.key && /^\/works\/OL\w+$/.test(doc.key)) {
      try {
        const w = JSON.parse(await fetchRaw(`https://openlibrary.org${doc.key}.json`)) as {
          description?: string | { value?: string };
        };
        const desc = typeof w.description === 'string' ? w.description : w.description?.value;
        if (desc) out.description = desc.slice(0, 3000);
      } catch {
        // Sin descripción: el libro sigue con sus datos.
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** «⭐ Goodreads 4,52 (1,1 M valoraciones)» o «⭐ Goodreads: N/D (motivo)». */
export function goodreadsLine(g: Goodreads | undefined): string | null {
  if (!g) return null;
  if (!g.ok || g.rating === undefined) return `⭐ Goodreads: N/D (${g.reason ?? 'sin datos'})`;
  const n = g.ratings ?? 0;
  const count =
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} M`
      : n >= 10_000
        ? `${Math.round(n / 1000)} mil`
        : n.toLocaleString('es-ES');
  return `⭐ Goodreads ${g.rating.toFixed(2).replace('.', ',')}/5 (${count} valoraciones)`;
}
