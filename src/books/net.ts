/**
 * Downloads for the book tool. The hosts are a fixed list, redirects are followed by
 * hand and re-checked on every hop, and the bytes must really be an EPUB or a PDF.
 * The model supplies an id, never a URL.
 */
const ALLOWED = ['gutenberg.org', 'archive.org', 'gutendex.com'];
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
): Promise<{ bytes: Buffer; kind: 'epub' | 'pdf' }> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedBookHost(current))
      throw new Error('la descarga redirige fuera de las fuentes permitidas');
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
