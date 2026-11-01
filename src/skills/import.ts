/**
 * Importación de skills desde una URL, en el formato agentskills: un SKILL.md
 * con frontmatter YAML (`name`, `description`) y cuerpo Markdown.
 *
 * Importar es abrirle la puerta al agente a instrucciones que no escribió el
 * dueño, así que el parser es deliberadamente estricto: exige las dos claves
 * del frontmatter, un cuerpo real y un id seguro para usarlo como directorio, y
 * rechaza secretos, URLs que llevan credenciales en la query y frases típicas
 * de inyección de prompt. La descarga solo acepta https, tiene timeout, tope de
 * bytes y redirecciones manuales para volver a validar el esquema en cada salto.
 */
import { looksLikeSecret } from '../memory/snapshot.js';
import { foldAccents } from '../text.js';
import type { Skill, SkillDraft } from './types.js';

export const SKILL_MAX_BYTES = 64 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_ID_LENGTH = 64;

const ALLOWED_CONTENT_TYPES = new Set(['text/markdown', 'text/plain', 'application/octet-stream']);

/** Credenciales metidas en la query de un enlace: exfiltración evidente. */
const EXFILTRATION_QUERY = /[?&](?:token|key|api[_-]?key|apikey|access[_-]?token|secret)=/i;

/** Frases que intentan que el modelo desobedezca lo que ya se le pidió. */
const INJECTION_PHRASES = [
  'ignora las instrucciones',
  'ignora todas las instrucciones',
  'ignora las instrucciones anteriores',
  'ignora las instrucciones previas',
  'olvida las instrucciones',
  'olvida tus instrucciones',
  'ignore instructions',
  'ignore previous instructions',
  'ignore all previous instructions',
  'ignore the previous instructions',
  'ignore prior instructions',
  'ignore your instructions',
  'disregard previous instructions',
  'disregard all previous instructions',
  'forget previous instructions',
];

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
}

export interface SkillParseError {
  ok: false;
  reason: string;
}

export interface ParsedSkill {
  ok: true;
  id: string;
  name: string;
  description: string;
}

export type SkillParseResult = ParsedSkill | SkillParseError;

export interface FetchSkillOptions {
  /** Tiempo máximo para toda la operación, redirecciones y cuerpo incluidos. */
  timeoutMs?: number;
  /** Tope de bytes del cuerpo descargado. */
  maxBytes?: number;
  /** Inyectable en tests; por defecto, el fetch global. */
  fetchImpl?: typeof fetch;
}

export type SkillSave = (md: string, meta: SkillMeta) => Promise<void>;

/**
 * Error de importación con el motivo separado del mensaje, para que la capa que
 * llama pueda decidir qué enseñar sin volver a parsear texto.
 */
export class SkillImportError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'SkillImportError';
    this.reason = reason;
  }
}

/**
 * Revisa texto de terceros o de disco antes de meterlo en el prompt (skills,
 * ficheros de proyecto): secretos, URLs con credenciales en la query y frases
 * de inyección. Devuelve el motivo del rechazo o null si pasa.
 */
export function screenUntrustedText(text: string): string | null {
  const secret = looksLikeSecret(text);
  if (secret) return `parece contener ${secret}`;
  if (EXFILTRATION_QUERY.test(text)) {
    return 'contiene una URL con credenciales en la query (token/key)';
  }
  const folded = fold(text).replace(/\s+/g, ' ');
  const injection = INJECTION_PHRASES.find((phrase) => folded.includes(phrase));
  if (injection) return `contiene instrucciones sospechosas ("${injection}")`;
  return null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fold(value: string): string {
  return foldAccents(value);
}

/** Deshace las comillas simples o dobles del subconjunto YAML que aceptamos. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/** Id seguro como nombre de directorio: minúsculas, números y guiones. */
function sanitizeId(raw: string): string {
  return fold(raw)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
}

interface FrontmatterOk {
  ok: true;
  meta: Map<string, string>;
  body: string;
}

function splitFrontmatter(markdown: string): FrontmatterOk | SkillParseError {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let start = 0;
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++;
  if ((lines[start] ?? '').trim() !== '---') {
    return { ok: false, reason: 'no parece una skill: falta la cabecera entre líneas ---' };
  }
  let end = -1;
  for (let index = start + 1; index < lines.length; index++) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) {
    return { ok: false, reason: 'la cabecera de la skill no se cierra con una línea ---' };
  }
  const meta = new Map<string, string>();
  for (let index = start + 1; index < end; index++) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1));
    if (key && value) meta.set(key, value);
  }
  return { ok: true, meta, body: lines.slice(end + 1).join('\n') };
}

/**
 * Convierte un SKILL.md en metadatos instalables. Nunca lanza: cualquier
 * problema de formato, tamaño o seguridad vuelve como `{ ok: false, reason }`.
 */
export function parseSkillMarkdown(md: string): SkillParseResult {
  if (typeof md !== 'string') {
    return { ok: false, reason: 'la skill no es un archivo de texto' };
  }
  if (Buffer.byteLength(md, 'utf8') > SKILL_MAX_BYTES) {
    return {
      ok: false,
      reason: `la skill es demasiado grande (máximo ${Math.floor(SKILL_MAX_BYTES / 1024)} KB)`,
    };
  }
  const front = splitFrontmatter(md);
  if (!front.ok) return front;
  const name = oneLine(front.meta.get('name') ?? '');
  if (!name) return { ok: false, reason: 'a la skill le falta un nombre válido' };
  const description = oneLine(front.meta.get('description') ?? '');
  if (!description) {
    return { ok: false, reason: 'a la skill le falta una descripción válida' };
  }
  if (!front.body.trim()) {
    return { ok: false, reason: 'la skill no trae instrucciones, solo la cabecera' };
  }
  const secret = looksLikeSecret(md);
  if (secret) {
    return { ok: false, reason: `la skill parece contener ${secret} y no la instalo` };
  }
  if (EXFILTRATION_QUERY.test(md)) {
    return {
      ok: false,
      reason: 'la skill trae un enlace con una clave dentro y no la instalo',
    };
  }
  // Se colapsan los espacios para que una frase partida en varias líneas no
  // esquive la comprobación.
  const folded = fold(md).replace(/\s+/g, ' ');
  const injection = INJECTION_PHRASES.find((phrase) => folded.includes(phrase));
  if (injection) {
    return {
      ok: false,
      reason: `la skill contiene instrucciones sospechosas ("${injection}")`,
    };
  }
  const rawId = (front.meta.get('id') ?? '').trim() || name;
  const id = sanitizeId(rawId);
  if (!id) {
    return { ok: false, reason: 'no puedo sacar un nombre válido para la skill' };
  }
  return { ok: true, id, name, description };
}

function parseHttpsUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Ese enlace no es válido');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Solo instalo skills desde enlaces https');
  }
  return parsed;
}

/** Lectura de cabeceras tolerante a dobles de test que no son un `Headers`. */
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

function assertContentType(response: Response): void {
  const raw = headerValue(response.headers, 'content-type');
  if (!raw) return;
  const [head] = raw.split(';');
  const type = (head ?? '').trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(type)) {
    throw new Error(
      'Ese enlace no lleva a un archivo de texto (parece una web u otro tipo de archivo)',
    );
  }
}

/**
 * Lee el cuerpo con tope. Se corta en cuanto se pasa del límite en vez de
 * esperar a tener el fichero entero en memoria: una URL hostil no debe poder
 * llenar el disco ni el heap antes de que el parser diga que no.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declaredRaw = headerValue(response.headers, 'content-length');
  const declared = declaredRaw === null ? Number.NaN : Number(declaredRaw);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`La skill es demasiado grande (máximo ${sizeText(maxBytes)})`);
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
        throw new Error(`La skill es demasiado grande (máximo ${sizeText(maxBytes)})`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`La skill es demasiado grande (máximo ${sizeText(maxBytes)})`);
    }
    return buffer.toString('utf8');
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`La skill es demasiado grande (máximo ${sizeText(maxBytes)})`);
    }
    return text;
  }
  throw new Error('El enlace no ha devuelto nada que pueda leer');
}

/** Tamaño legible para el dueño («100 bytes», «64 KB», «2 MB»). */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** Espera legible para el dueño: «15 s» en vez de «15000 ms». */
export function secondsText(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : 'un segundo';
}

function timeoutError(timeoutMs: number): Error {
  return new Error(
    `El enlace ha tardado demasiado en responder (más de ${secondsText(timeoutMs)})`,
  );
}

/**
 * Descarga un SKILL.md. Solo https (también en cada redirección), timeout
 * global con AbortSignal, tope de bytes y tipos de contenido de texto. Las
 * redirecciones son manuales para no aceptar un salto silencioso a http.
 */
export async function fetchSkillMarkdown(
  url: string,
  opts: FetchSkillOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? SKILL_MAX_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs debe ser un número positivo');
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes debe ser un número positivo');
  }
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('No hay fetch disponible para descargar el skill');
  }
  let current = parseHttpsUrl(url);
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
        signal: controller.signal,
        headers: { accept: 'text/markdown, text/plain, application/octet-stream' },
      });
      if (isRedirect(response.status)) {
        const location = headerValue(response.headers, 'location');
        if (!location) {
          throw new Error('El enlace redirige a otra dirección sin decir cuál');
        }
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(
            `El enlace da demasiadas vueltas (más de ${MAX_REDIRECTS} redirecciones)`,
          );
        }
        try {
          current = parseHttpsUrl(new URL(location, current).toString());
        } catch (err) {
          if (err instanceof TypeError)
            throw new Error('El enlace redirige a una dirección que no entiendo');
          throw err;
        }
        const body = response.body;
        if (body && typeof body.cancel === 'function') {
          await body.cancel().catch(() => undefined);
        }
        continue;
      }
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'No hay nada en ese enlace (error 404)'
            : `El servidor no me ha dado la skill (error ${response.status})`,
        );
      }
      assertContentType(response);
      return await readCapped(response, maxBytes);
    }
  };

  try {
    return await Promise.race([download(), deadline]);
  } catch (err) {
    if (timedOut || controller.signal.aborted) throw timeoutError(timeoutMs);
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Instala un skill ya descargado: parsea, entrega el Markdown y la meta al
 * guardián y devuelve lo justo para confirmar la instalación. Un fallo de
 * parseo se convierte en `SkillImportError` con `reason`; un fallo de `save`
 * se propaga tal cual, porque el llamador necesita saber que no se guardó.
 */
export async function installSkill(
  md: string,
  save: SkillSave,
): Promise<{ id: string; name: string }> {
  const parsed = parseSkillMarkdown(md);
  if (!parsed.ok) throw new SkillImportError(parsed.reason);
  await save(md, {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
  });
  return { id: parsed.id, name: parsed.name };
}

/**
 * Lo que se guarda de un skill importado. Siempre `outward: true`: un fichero
 * descargado no puede declararse inofensivo, así que antes de enviar, reservar
 * o gastar nada se pide permiso. No pisa una habilidad propia (sembrada,
 * aprendida o del dueño) con el mismo nombre: quedaría con pasos de fuera.
 */
export function importedSkillDraft(
  md: string,
  meta: SkillMeta,
  url: string,
  existing: Skill | null = null,
): SkillDraft {
  // Solo se puede re-importar encima de otra importada; nunca encima de una
  // sembrada, aprendida o del dueño.
  if (existing && (existing.trust !== 'community' || existing.category !== 'importadas')) {
    throw new SkillImportError(
      `ya tengo una habilidad propia llamada «${existing.name}»; no la sustituyo por una de fuera`,
    );
  }
  const steps = md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('---') && !/^(name|description):/.test(l))
    .slice(0, 40);
  return {
    name: meta.name,
    description: meta.description,
    category: 'importadas',
    whenToUse: 'Cuando la tarea encaje con la descripción de la skill.',
    steps,
    notes: [`Importada de ${url}`],
    outward: true,
  };
}
