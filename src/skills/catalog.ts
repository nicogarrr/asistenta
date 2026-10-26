/**
 * Catálogo/marketplace local de skills.
 *
 * El catálogo es solo una lista de metadatos: dice qué recetas existen y dónde
 * vive su SKILL.md, pero no instala nada por su cuenta. Instalar sigue siendo
 * un acto explícito que pasa por `import.ts` y sus validaciones.
 *
 * Todo lo que llega de fuera se trata como hostil: solo se aceptan enlaces
 * https, el JSON se valida entrada a entrada y una entrada mala se descarta sin
 * tumbar el resto del catálogo (se cuenta en `skipped` para que la interfaz
 * pueda avisar). La descarga usa redirecciones manuales para revalidar el
 * esquema en cada salto, timeout global y tope de bytes.
 */
import { isSkillId } from './store.js';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  tags?: string[];
  source: 'local' | 'github' | 'url';
}

/** Tope del catálogo entero: más entradas es señal de feed manipulado o roto. */
const MAX_ENTRIES = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function text(value: unknown): string {
  return typeof value === 'string' ? oneLine(value) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSource(value: unknown): value is CatalogEntry['source'] {
  return value === 'local' || value === 'github' || value === 'url';
}

/**
 * Un enlace de catálogo sirve para que el usuario lo abra o para descargar un
 * SKILL.md; credenciales embebidas en la URL no tienen uso legítimo aquí.
 */
function isHttpsUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function inferSource(url: string): CatalogEntry['source'] {
  const host = new URL(url).hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com') ? 'github' : 'url';
}

/**
 * `tags` es opcional, pero si viene debe ser un array. Los elementos que no
 * sean texto se ignoran y los repetidos se colapsan para que la vista no
 * muestre la misma etiqueta dos veces.
 */
function parseTags(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = oneLine(item);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** Una entrada inválida devuelve null y el llamador la cuenta como saltada. */
function parseEntry(raw: unknown): CatalogEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string') return null;
  const id = raw.id.trim();
  if (!isSkillId(id)) return null;
  const name = text(raw.name);
  if (!name) return null;
  const description = text(raw.description);
  if (!description) return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!isHttpsUrl(url)) return null;
  const source =
    raw.source === undefined ? inferSource(url) : isSource(raw.source) ? raw.source : null;
  if (!source) return null;
  const tags = parseTags(raw.tags);
  if (tags === null) return null;
  const entry: CatalogEntry = { id, name, description, url, source };
  if (tags !== undefined) entry.tags = tags;
  return entry;
}

/**
 * Parsea el JSON `{ skills: [...] }` de un catálogo.
 *
 * Los fallos estructurales (no es JSON, no hay lista, supera el tope) devuelven
 * `ok: false`. Los fallos de una entrada concreta (id inválido o repetido, URL
 * que no es https, campos vacíos, `source` desconocido) se saltan y se resumen
 * en `skipped`, porque un catálogo remoto con una fila mala no debe impedir
 * ver las buenas.
 */
export function parseCatalog(
  json: string,
): { ok: true; entries: CatalogEntry[]; skipped: number } | { ok: false; reason: string } {
  if (typeof json !== 'string' || !json.trim()) {
    return { ok: false, reason: 'el catálogo está vacío' };
  }
  let root: unknown;
  try {
    root = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, reason: 'el catálogo no es JSON válido' };
  }
  if (!isRecord(root)) {
    return { ok: false, reason: 'el catálogo debe ser un objeto JSON' };
  }
  const skills = root.skills;
  if (!Array.isArray(skills)) {
    return { ok: false, reason: 'el catálogo no tiene una lista skills' };
  }
  if (skills.length > MAX_ENTRIES) {
    return { ok: false, reason: `el catálogo supera el máximo de ${MAX_ENTRIES} skills` };
  }
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of skills) {
    const entry = parseEntry(raw);
    if (!entry || seen.has(entry.id)) {
      skipped++;
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { ok: true, entries, skipped };
}

/**
 * Catálogo de ejemplo que viaja con el agente. Son recetas genéricas y sus
 * enlaces son de ejemplo (example.com): no prometen contenido real, solo
 * demuestran el formato sin depender de la red.
 */
export const BUILTIN_CATALOG: string = JSON.stringify(
  {
    skills: [
      {
        id: 'resumen-de-email',
        name: 'Resumen de email',
        description: 'Resume los correos sin leer y separa lo urgente de lo que puede esperar.',
        url: 'https://example.com/skills/resumen-de-email/SKILL.md',
        tags: ['email', 'resumen', 'productividad'],
        source: 'url',
      },
      {
        id: 'buscar-en-web',
        name: 'Buscar en web',
        description: 'Busca en la web, contrasta las fuentes y devuelve una respuesta con enlaces.',
        url: 'https://example.com/skills/buscar-en-web/SKILL.md',
        tags: ['web', 'búsqueda', 'investigación'],
        source: 'url',
      },
      {
        id: 'organizar-descargas',
        name: 'Organizar descargas',
        description: 'Ordena la carpeta de descargas por tipo y fecha sin borrar ningún archivo.',
        url: 'https://example.com/skills/organizar-descargas/SKILL.md',
        tags: ['archivos', 'descargas', 'organización'],
        source: 'url',
      },
      {
        id: 'revisar-precios',
        name: 'Revisar precios',
        description: 'Consulta el precio de una lista de productos y avisa solo si baja.',
        url: 'https://example.com/skills/revisar-precios/SKILL.md',
        tags: ['compras', 'precios', 'seguimiento'],
        source: 'url',
      },
    ],
  },
  null,
  2,
);

/**
 * Cruza el catálogo con los ids ya instalados. No muta las entradas: devuelve
 * copias con `installed` para que la vista pueda marcar “Instalar” o
 * “Instalado” sin perder el catálogo original.
 */
export function mergeCatalog(
  entries: CatalogEntry[],
  installedIds: string[],
): Array<CatalogEntry & { installed: boolean }> {
  const installed = new Set(installedIds);
  return entries.map((entry) => ({ ...entry, installed: installed.has(entry.id) }));
}

/**
 * Convierte los skills instalados en entradas locales del catálogo, sin red.
 * Un skill local no tiene una URL pública que inventar: se deja vacía y la
 * interfaz debe mostrar la procedencia `local` en vez de un enlace.
 */
export function catalogFromInstalled(
  choices: Array<{ id: string; name: string; description?: string }>,
): CatalogEntry[] {
  return choices.map((choice) => ({
    id: choice.id,
    name: oneLine(choice.name),
    description: oneLine(choice.description ?? ''),
    url: '',
    source: 'local',
  }));
}

function parseHttpsCatalogUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('la URL del catálogo no es válida');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('solo se puede descargar un catálogo desde una URL https');
  }
  return parsed;
}

/** Lectura tolerante a dobles de test que no usan un `Headers` real. */
function headerValue(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = get.call(headers, name);
    return typeof value === 'string' ? value : null;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`la descarga del catálogo superó el tiempo límite (timeout) de ${timeoutMs} ms`);
}

/**
 * Lee el cuerpo con tope y se corta en cuanto se pasa del límite. Se mira
 * también `content-length` para no empezar siquiera un cuerpo declarado enorme.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declaredRaw = headerValue(response.headers, 'content-length');
  const declared = declaredRaw === null ? Number.NaN : Number(declaredRaw);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`el catálogo supera el límite de ${maxBytes} bytes`);
  }
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`el catálogo supera el límite de ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`el catálogo supera el límite de ${maxBytes} bytes`);
    }
    return buffer.toString('utf8');
  }
  if (typeof response.text === 'function') {
    const value = await response.text();
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new Error(`el catálogo supera el límite de ${maxBytes} bytes`);
    }
    return value;
  }
  throw new Error('la respuesta del catálogo no tiene un cuerpo legible');
}

/**
 * Descarga y parsea un catálogo remoto. Nunca lanza: cualquier fallo de red,
 * timeout, tamaño, redirección o formato vuelve como `{ ok: false, reason }`.
 *
 * Solo https, también después de cada redirección (como máximo dos). El timeout
 * cubre toda la operación mediante un `AbortSignal` global.
 */
export async function fetchCatalog(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<{ ok: true; entries: CatalogEntry[] } | { ok: false; reason: string }> {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs debe ser un número positivo');
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes debe ser un número positivo');
    }
    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
      throw new Error('no hay fetch disponible para descargar el catálogo');
    }
    let current = parseHttpsCatalogUrl(url);
    const controller = new AbortController();
    const signal = controller.signal;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    });

    const download = async (): Promise<string> => {
      for (let redirects = 0; ; redirects++) {
        const response = await doFetch(current.toString(), {
          redirect: 'manual',
          signal,
          headers: { accept: 'application/json, text/plain' },
        });
        if (isRedirect(response.status)) {
          const location = headerValue(response.headers, 'location');
          if (!location) {
            throw new Error('la redirección no incluye una cabecera Location');
          }
          if (redirects >= MAX_REDIRECTS) {
            throw new Error(`demasiadas redirecciones (máximo ${MAX_REDIRECTS})`);
          }
          current = parseHttpsCatalogUrl(new URL(location, current).toString());
          const body = response.body;
          if (body && typeof body.cancel === 'function') {
            await body.cancel().catch(() => undefined);
          }
          continue;
        }
        if (!response.ok) {
          throw new Error(`el servidor respondió con estado ${response.status}`);
        }
        return await readCapped(response, maxBytes);
      }
    };

    const raw = await Promise.race([download(), deadline]);
    const parsed = parseCatalog(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, entries: parsed.entries };
  } catch (err) {
    if (timedOut) return { ok: false, reason: timeoutError(timeoutMs).message };
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'no se pudo descargar el catálogo',
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
