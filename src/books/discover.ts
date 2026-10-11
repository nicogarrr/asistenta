/** Descubrimiento del bot vigente de Biblioteca Secreta.
 *
 * El bot rota cada poco; bibliotecasecreta.nl siempre apunta al actual
 * (redirige a telegra.ph con los handles vigentes). Cache corto en memoria:
 * si el bot no responde, se fuerza re-descubrimiento.
 */

const SOURCE_URL = 'https://bibliotecasecreta.nl';
const CACHE_TTL_MS = 15 * 60 * 1000;

const HANDLE_RE = /(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,64})\b/g;

let cache: { handle: string; at: number } | undefined;

export function extractBotHandles(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(HANDLE_RE)) {
    const handle = m[1];
    if (!handle) continue;
    // Descarta handles genericos que no son el bot (canales de anuncios, soporte).
    if (!/bot$/i.test(handle)) continue;
    seen.add(handle);
  }
  return [...seen];
}

const BODY_CAP = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** Lee el cuerpo con tope duro: una pagina gigante o infinita no infla memoria. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > BODY_CAP) throw new Error('pagina demasiado grande (tope 512KB)');
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_CAP) {
      await reader.cancel();
      throw new Error('pagina demasiado grande (tope 512KB)');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

export async function discoverBotHandle(options?: {
  fetchImpl?: typeof fetch;
  force?: boolean;
  now?: number;
}): Promise<string> {
  const now = options?.now ?? Date.now();
  if (!options?.force && cache && now - cache.at < CACHE_TTL_MS) {
    return cache.handle;
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  // La home redirige a telegra.ph; fetch sigue redirecciones solo. Timeout
  // duro: una pagina colgada nunca deja el pipeline esperando.
  const res = await fetchImpl(SOURCE_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bibliotecasecreta.nl responde ${res.status}`);
  const html = await readCapped(res);
  const handles = extractBotHandles(html);
  if (handles.length === 0) {
    throw new Error('No se encontro ningun handle de bot en bibliotecasecreta.nl');
  }
  // Seleccion anclada: varios handles distintos = pagina rara o comprometida;
  // jamas se elige uno al azar.
  if (handles.length > 1) {
    throw new Error(`Descubrimiento ambiguo: varios bots (${handles.join(', ')})`);
  }
  const first = handles[0];
  if (!first) throw new Error('No se encontro ningun handle de bot en bibliotecasecreta.nl');
  cache = { handle: first, at: now };
  return first;
}

/** Invalida la cache (bot caido/rotado: la proxima llamada re-descubre). */
export function invalidateBotCache(): void {
  cache = undefined;
}
