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

/**
 * A ZIP is not a book by itself: a .zip of PDFs, a DOCX or a site's "download.zip"
 * also start with "PK". An EPUB carries its OCF markers: the uncompressed
 * "application/epub+zip" mimetype entry at the start (the spec, checked by
 * books/secret.ts sniffsAsEpub) or, in the many real files that store it compressed or later, the
 * "META-INF/container.xml" entry whose name every ZIP keeps in plain text.
 */
export function sniff(bytes: Uint8Array): 'epub' | 'pdf' | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = buf.subarray(0, 8).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (!head.startsWith('PK\u0003\u0004')) return null;
  const spec = buf.length >= 64 && buf.subarray(0, 512).includes('application/epub+zip');
  if (spec || buf.includes('META-INF/container.xml')) return 'epub';
  return null;
}

/**
 * The body, read chunk by chunk and abandoned the moment it passes `maxBytes`.
 *
 * `arrayBuffer()` buffered the whole download before the size was checked, so a
 * server that sends no Content-Length (or a false one) could push gigabytes into the
 * daemon's memory from a link pasted in a chat before the 50 MB rule ever ran.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const tooBig = () => new Error('el archivo supera 50 MB (límite de Telegram y Kindle)');
  if (!res.body) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > maxBytes) throw tooBig();
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
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
    const buf = await readCapped(res, maxBytes);
    const kind = sniff(buf);
    if (!kind) throw new Error('lo descargado no es un EPUB ni un PDF');
    return { bytes: buf, kind };
  }
  throw new Error('demasiadas redirecciones');
}
