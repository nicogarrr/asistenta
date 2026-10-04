/**
 * Downloads for the book tool. The hosts are a fixed list, redirects are followed by
 * hand and re-checked on every hop, and the bytes must really be an EPUB or a PDF.
 *
 * The catalogue searches only ever produce ids, and every download goes through this
 * allow list, so a compromised or edited catalogue response cannot redirect the agent
 * at an arbitrary host. A link the user pastes himself is a different case: that is an
 * explicit instruction, so it is checked for being a public https URL rather than being
 * matched against a list, and the bytes still have to sniff as a real book.
 */
import { isFetchableResolved } from '../tools/fetch.js';

const ALLOWED = [
  'gutenberg.org',
  'gutendex.com',
  'archive.org',
  'openlibrary.org',
  'wikisource.org',
  'es.wikisource.org',
];
export const MAX_BOOK_BYTES = 50 * 1024 * 1024;

export function allowedBookHost(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return ALLOWED.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

/**
 * Whether a user-supplied link may be fetched: public https only.
 *
 * Localhost, private ranges and metadata hosts are refused, which is the same rule the
 * rest of the project follows, and it matters more here than elsewhere because a book
 * link arrives from a chat message.
 */
export async function allowedDirectBookUrl(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return isFetchableResolved(u.toString());
}

export type Fetcher = (url: string, init?: { redirect: 'manual' }) => Promise<Response>;

export async function getJson(url: string, fetcher: Fetcher = fetch): Promise<unknown> {
  if (!allowedBookHost(url)) throw new Error('fuente no permitida');
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`la fuente respondió ${res.status}`);
  return res.json();
}

export function sniff(bytes: Uint8Array): 'epub' | 'pdf' | null {
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) return 'epub';
  return null;
}

export async function downloadBook(
  url: string,
  fetcher: Fetcher = fetch,
  maxBytes = MAX_BOOK_BYTES,
  opts: { direct?: boolean } = {},
): Promise<{ bytes: Buffer; kind: 'epub' | 'pdf' }> {
  // A catalogue download must stay on the allow list on every hop. A link the user
  // pasted is checked for being a public https URL instead, which is the whole reason
  // it is allowed to leave the list at all.
  const permitted = async (candidate: string): Promise<boolean> =>
    opts.direct ? allowedDirectBookUrl(candidate) : allowedBookHost(candidate);

  if (!(await permitted(url))) {
    throw new Error(
      opts.direct
        ? 'ese enlace no es una dirección web pública https; no lo descargo'
        : 'la descarga sale de las fuentes permitidas',
    );
  }
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!(await permitted(current)))
      throw new Error(
        opts.direct
          ? 'el enlace redirige a una dirección que no es pública; no sigo'
          : 'la descarga redirige fuera de las fuentes permitidas',
      );
    const res = await fetcher(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirección sin destino');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`la descarga respondió ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes)
      throw new Error('el archivo supera 50 MB (límite de Telegram y Kindle)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes)
      throw new Error('el archivo supera 50 MB (límite de Telegram y Kindle)');
    const kind = sniff(buf);
    if (!kind) throw new Error('lo descargado no es un EPUB ni un PDF');
    return { bytes: buf, kind };
  }
  throw new Error('demasiadas redirecciones');
}
