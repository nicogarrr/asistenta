/**
 * The languages the user actually wants, as the codes every one of these catalogues
 * happens to use. Kept as data so the tool can say "no hay en castellano" instead of
 * quietly handing back an English edition under a Spanish request.
 */
const SPANISH = new Set([
  'spa',
  'es',
  'sp',
  'castellano',
  'spanish',
  'español',
  'espanol',
  'lengua castellana',
]);

/** Whether a catalogue's language field says Spanish. Unknown is not Spanish. */
export function isSpanish(language: string | undefined): boolean {
  if (!language) return false;
  return SPANISH.has(language.trim().toLowerCase());
}

/**
 * Where books come from. Only sources that publish public-domain or free editions:
 * Project Gutenberg (through the Gutendex catalogue), the Internet Archive limited to
 * items its own metadata marks NOT_IN_COPYRIGHT, Open Library (which is an index over
 * those same public-domain scans) and the Spanish Wikisource. Nothing here searches the
 * open web for "pdf gratis": that is how pirated copies get in, and a link the user
 * supplies himself is the only outside URL that is ever fetched.
 *
 * Every function takes the HTTP getter as a parameter so the tests never touch the
 * network.
 */
export type BookSource = 'gutenberg' | 'archive' | 'openlibrary' | 'wikisource';

export interface BookFile {
  kind: 'epub' | 'pdf';
  url: string;
  /** Internet Archive scans ("Image Container PDF") have no real text layer. */
  scanned?: boolean;
  bytes?: number;
}

export interface BookHit {
  source: BookSource;
  id: string;
  title: string;
  authors: string[];
  language: string;
  /** Only known after resolve() for the Internet Archive; always present for Gutenberg. */
  files: BookFile[];
  downloads?: number;
}

export type GetJson = (url: string) => Promise<unknown>;

const GUTENDEX = 'https://gutendex.com/books/';
const ARCHIVE_SEARCH = 'https://archive.org/advancedsearch.php';
const ARCHIVE_META = 'https://archive.org/metadata/';
const OPEN_LIBRARY = 'https://openlibrary.org/search.json';
const WIKISOURCE_API = 'https://es.wikisource.org/w/api.php';
const WIKISOURCE_BASE = 'https://es.wikisource.org/wiki';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "Cervantes Saavedra, Miguel de" -> "Miguel de Cervantes Saavedra". */
export function tidyAuthor(name: string): string {
  const parts = name.split(',').map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : name.trim();
}

export async function searchGutenberg(
  query: string,
  getJson: GetJson,
  opts: { language?: string; limit?: number } = {},
): Promise<BookHit[]> {
  const params = new URLSearchParams({ search: query });
  if (opts.language) params.set('languages', opts.language);
  const data = obj(await getJson(`${GUTENDEX}?${params}`));
  const hits: BookHit[] = [];
  for (const raw of arr(data.results)) {
    const r = obj(raw);
    // `copyright: true` is in copyright; null is unknown. Only an explicit false passes.
    if (r.copyright !== false) continue;
    const formats = obj(r.formats);
    const files: BookFile[] = [];
    const epub = str(formats['application/epub+zip']);
    if (epub) files.push({ kind: 'epub', url: epub });
    const pdf = str(formats['application/pdf']);
    if (pdf) files.push({ kind: 'pdf', url: pdf });
    if (!files.length) continue;
    hits.push({
      source: 'gutenberg',
      id: String(r.id ?? ''),
      title: str(r.title),
      authors: arr(r.authors)
        .map((a) => tidyAuthor(str(obj(a).name)))
        .filter(Boolean),
      language: str(arr(r.languages)[0]),
      files,
      downloads: typeof r.download_count === 'number' ? r.download_count : undefined,
    });
    if (hits.length >= (opts.limit ?? 5)) break;
  }
  return hits;
}

export async function searchArchive(
  query: string,
  getJson: GetJson,
  opts: { limit?: number } = {},
): Promise<BookHit[]> {
  // Quotes and Lucene operators from the user would change the query's meaning.
  const clean = query
    .replace(/["():\\[\]{}^~*?\\\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const params = new URLSearchParams({
    q: `(${clean}) AND mediatype:texts AND possible-copyright-status:NOT_IN_COPYRIGHT`,
    rows: String(opts.limit ?? 5),
    output: 'json',
  });
  for (const f of ['identifier', 'title', 'creator', 'language', 'downloads']) {
    params.append('fl[]', f);
  }
  const data = obj(obj(await getJson(`${ARCHIVE_SEARCH}?${params}`)).response);
  return arr(data.docs)
    .map((raw) => {
      const d = obj(raw);
      const creator = d.creator;
      return {
        source: 'archive' as const,
        id: str(d.identifier),
        title: str(d.title),
        authors: (Array.isArray(creator) ? creator : [creator]).map(str).filter(Boolean),
        language: str(Array.isArray(d.language) ? d.language[0] : d.language),
        files: [],
        downloads: typeof d.downloads === 'number' ? d.downloads : undefined,
      };
    })
    .filter((h) => h.id);
}

export async function resolveArchiveItem(
  id: string,
  getJson: GetJson,
): Promise<{ title: string; authors: string[]; files: BookFile[] }> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('identificador de archive.org no válido');
  const meta = obj(await getJson(`${ARCHIVE_META}${id}`));
  // Defence in depth: the search already filtered on this, but a stale or hand-typed id
  // must not slip a copyrighted upload through.
  const status = str(obj(meta.metadata)['possible-copyright-status']);
  if (status !== 'NOT_IN_COPYRIGHT') {
    throw new Error('archive.org no marca este libro como dominio público; no lo descargo');
  }
  const files: BookFile[] = [];
  for (const raw of arr(meta.files)) {
    const f = obj(raw);
    const name = str(f.name);
    const format = str(f.format);
    const bytes = Number(f.size) || undefined;
    const url = `https://archive.org/download/${id}/${encodeURIComponent(name)}`;
    if (format === 'EPUB') files.push({ kind: 'epub', url, bytes });
    else if (format === 'Text PDF') files.push({ kind: 'pdf', url, bytes });
    else if (format === 'Image Container PDF')
      files.push({ kind: 'pdf', url, bytes, scanned: true });
  }
  const creator = obj(meta.metadata).creator;
  return {
    title: str(obj(meta.metadata).title) || id,
    authors: (Array.isArray(creator) ? creator : [creator]).map(str).filter(Boolean),
    files,
  };
}

/**
 * Open Library, which indexes the Internet Archive's public-domain scans and adds a few
 * of its own. It is the widest free catalogue that has a documented API, and it answers
 * a language filter, which is what makes "solo en castellano" enforceable.
 *
 * `ia` holds Internet Archive identifiers, so a hit resolves through the same
 * archive.org metadata check as any other item: Open Library is an index, not a licence,
 * and a hit with no readable file is dropped rather than offered.
 */
export async function searchOpenLibrary(
  query: string,
  getJson: GetJson,
  opts: { language?: string; limit?: number } = {},
): Promise<BookHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(opts.limit ?? 8) });
  if (opts.language) params.set('language', opts.language);
  for (const f of ['title', 'author_name', 'ia', 'language', 'ebook_access']) {
    params.append('fields', f);
  }
  const data = obj(await getJson(`${OPEN_LIBRARY}?${params}`));
  const hits: BookHit[] = [];
  for (const raw of arr(data.docs)) {
    const d = obj(raw);
    const languages = arr(d.language).map(str).filter(Boolean);
    // A search filtered on language can still return rows without the field, and a row
    // without it is not evidence of Spanish.
    if (opts.language && !languages.some((l) => isSpanish(l))) continue;
    const identifiers = arr(d.ia).map(str).filter(Boolean);
    if (!identifiers.length) continue;
    const access = str(d.ebook_access);
    // borrowable means lending only, which we cannot deliver. no_ebook means there is
    // nothing to fetch. Only a public, readable item is worth offering.
    if (access === 'no_ebook' || access === 'borrowable') continue;
    const [identifier] = identifiers;
    if (!identifier) continue;
    hits.push({
      source: 'openlibrary',
      id: identifier,
      title: str(d.title),
      authors: arr(d.author_name).map(str).filter(Boolean),
      language: languages[0] ?? '',
      files: [],
    });
    if (hits.length >= (opts.limit ?? 5)) break;
  }
  return hits;
}

/**
 * The Spanish Wikisource, through the MediaWiki API every wiki exposes.
 *
 * It is a catalogue of public-domain texts with no download of its own: the texts are
 * fetched from the wiki itself, so a hit carries the wiki URL and the `get` action reads
 * the article. Useful for short works and for authors the big catalogues do not carry.
 */
export async function searchWikisource(
  query: string,
  getJson: GetJson,
  opts: { limit?: number } = {},
): Promise<BookHit[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srnamespace: '0',
    srlimit: String(opts.limit ?? 5),
    format: 'json',
    origin: '*',
  });
  const data = obj(await getJson(`${WIKISOURCE_API}?${params}`));
  const hits: BookHit[] = [];
  for (const raw of arr(obj(data.query).search)) {
    const r = obj(raw);
    const title = str(r.title);
    if (!title) continue;
    hits.push({
      source: 'wikisource',
      id: title,
      title,
      authors: [],
      // The Spanish Wikisource is Spanish by construction; the field is required and a
      // blank one would read as "unknown language" to the filter above.
      language: 'spa',
      files: [{ kind: 'epub', url: `${WIKISOURCE_BASE}/${encodeURIComponent(title)}` }],
    });
  }
  return hits;
}

/** Best file first: EPUB, then a PDF with text, then a scanned PDF. */
export function pickFile(files: readonly BookFile[]): BookFile | undefined {
  const rank = (f: BookFile) => (f.kind === 'epub' ? 0 : f.scanned ? 2 : 1);
  return [...files].sort((a, b) => rank(a) - rank(b))[0];
}

export function describeHit(h: BookHit, n: number): string {
  const kinds = [...new Set(h.files.map((f) => f.kind.toUpperCase()))].join('/');
  const by = h.authors.length ? ` — ${h.authors.slice(0, 2).join(', ')}` : '';
  return `${n}. ${h.title}${by} [${h.language || '?'}] (${SOURCE_NAMES[h.source]}, ${kinds || 'formato por ver'}) id=${h.source}:${h.id}`;
}

const SOURCE_NAMES: Record<BookSource, string> = {
  gutenberg: 'Project Gutenberg',
  archive: 'Internet Archive',
  openlibrary: 'Open Library',
  wikisource: 'Wikisource',
};
