/**
 * Lo que dice Asistenta después de actualizarse. Nico (1 nov): el aviso acababa en
 * «y 1 cambio más» (o «y 531 cambios más») y no había forma de ver esos cambios.
 *
 * Ahora se ven todos, sin comandos nuevos:
 * - Si caben (hasta CHANGELOG_SHOW + CHANGELOG_SLACK), van todos en el aviso.
 * - Si son muchísimos, el aviso trae los CHANGELOG_SHOW más visibles y pregunta
 *   «¿Quieres verlos? Dime «sí»». El resto se guarda en la carpeta de estado y, si el
 *   siguiente mensaje del dueño es un «sí», el daemon lo manda en trozos que caben en
 *   Telegram. Lo de por dentro (orden interno, pruebas…) siempre va al final.
 *
 * Como la pregunta del paquete (daemon/parcel-checkin.ts): solo cuenta el mensaje
 * siguiente al aviso y durante un rato; después un «sí» ya no es para esto.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileReplacing } from './fs-tmp.js';
import { BUSY_DIR } from './ocupada.js';

/** Cuántos cambios enseña el aviso cuando son muchos. */
export const CHANGELOG_SHOW = 10;
/** Si solo sobran estos o menos, se enseñan también: esconder 1 sería absurdo. */
export const CHANGELOG_SLACK = 5;
/** Telegram rechaza más de 4096; se deja margen. */
export const NOVEDADES_CHUNK_MAX = 4000;
/** Cuánto vale un «sí» después del aviso. */
export const NOVEDADES_ANSWER_WINDOW_MS = 24 * 3_600_000;
export const NOVEDADES_FILE = 'novedades-pendientes.json';

export interface Novedad {
  text: string;
  /** Cambio por dentro (orden, pruebas, refactor…): no se nota al usarla. */
  internal: boolean;
}

/** «feat(tele): sube a tope (#712)» → «Sube a tope». */
export function cleanSubject(subject: string): string {
  let s = subject
    .trim()
    // Solo el tipo técnico («feat:», «fix(x)!:»); «Dictado: …» o «Tele: …» se quedan,
    // que dicen de qué va el cambio.
    .replace(
      /^(?:feat|fix|chore|refactor|docs?|tests?|ci|build|style|perf|revert)(\([^)]*\))?!?:\s*/i,
      '',
    )
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
  if (s.length > 110) s = `${s.slice(0, 109).trimEnd()}…`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const INTERNAL_TYPE =
  /^(?:refactor|tests?|chore|ci|build|style|lint|docs?|ordenar|orden|evolve)(?:\([^)]*\))?!?:/i;
const INTERNAL_WORDS =
  /(?:\borden interno\b|\brefactor\w*|\blimpieza\b|\bbiome\b|\blint\b|\btsc\b|\btipado\b|\btypecheck\b|\bpruebas?\b|\btests?\b|\bCI\b|\bdependencias\b|\w\.(?:ts|mjs|cjs)\b)/i;

function isInternal(raw: string, clean: string): boolean {
  return INTERNAL_TYPE.test(raw.trim()) || INTERNAL_WORDS.test(clean);
}

/** Asuntos de git → cambios limpios, sin repetidos ni merges; lo visible primero. */
export function novedades(subjects: string[]): Novedad[] {
  const seen = new Set<string>();
  const out: Novedad[] = [];
  for (const raw of subjects) {
    const text = cleanSubject(raw);
    if (!text || /^merge (pull request|branch|remote-tracking)/i.test(text)) continue;
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text, internal: isInternal(raw, text) });
  }
  return [...out.filter((n) => !n.internal), ...out.filter((n) => n.internal)];
}

export interface UpdateNotice {
  /** El aviso (un solo mensaje, siempre por debajo del límite de Telegram). */
  text: string;
  /** Lo que no cabe en el aviso: se ofrece con «¿Quieres verlos?». */
  rest: Novedad[];
}

export function buildUpdateNotice(subjects: string[]): UpdateNotice {
  const items = novedades(subjects);
  if (!items.length) return { text: '🆕 Me he actualizado\n• Cambios internos', rest: [] };
  if (items.length <= CHANGELOG_SHOW + CHANGELOG_SLACK) {
    return {
      text: ['🆕 Me he actualizado', ...items.map((n) => `• ${n.text}`)].join('\n'),
      rest: [],
    };
  }
  const shown = items.slice(0, CHANGELOG_SHOW);
  const rest = items.slice(CHANGELOG_SHOW);
  return {
    text: [
      '🆕 Me he actualizado. Lo más destacado:',
      ...shown.map((n) => `• ${n.text}`),
      `Hay otros ${rest.length} cambios. ¿Quieres verlos? Dime «sí» y te los paso.`,
    ].join('\n'),
    rest,
  };
}

/** Las líneas del aviso tras el título (lo que antes era la lista con «y N más»). */
export function formatChangelog(subjects: string[]): string[] {
  return buildUpdateNotice(subjects).text.split('\n').slice(1);
}

export function successMessage(subjects: string[]): string {
  return buildUpdateNotice(subjects).text;
}

/** El resto, en mensajes que caben en Telegram; lo de por dentro, en su apartado. */
export function novedadesChunks(rest: Novedad[]): string[] {
  const lines = [`Los otros ${rest.length} cambios:`];
  const visible = rest.filter((n) => !n.internal);
  const internal = rest.filter((n) => n.internal);
  for (const n of visible) lines.push(`• ${n.text}`);
  if (internal.length) {
    if (visible.length) lines.push('');
    lines.push('Por dentro (no notarás nada distinto):');
    for (const n of internal) lines.push(`• ${n.text}`);
  }
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > NOVEDADES_CHUNK_MAX && cur) {
      chunks.push(cur.trimEnd());
      cur = line;
    } else cur = next;
  }
  if (cur.trim()) chunks.push(cur.trimEnd());
  return chunks;
}

function pendingPath(stateDir: string): string {
  return join(stateDir, BUSY_DIR, NOVEDADES_FILE);
}

/** Lo apunta el proceso que se actualiza, justo antes de mandar el aviso. */
export function savePendingNovedades(stateDir: string, rest: Novedad[], now: number): void {
  const file = pendingPath(stateDir);
  try {
    if (!rest.length) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(join(stateDir, BUSY_DIR), { recursive: true });
    writeFileReplacing(file, JSON.stringify({ at: now, rest }));
  } catch {
    // Sin el fichero solo se pierde la oferta de ver el resto; la actualización sigue.
  }
}

function readPending(file: string): { at: number; rest: Novedad[] } | null {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    const { at, rest } = data as { at?: unknown; rest?: unknown };
    if (typeof at !== 'number' || !Array.isArray(rest)) return null;
    const ok = rest.filter(
      (n): n is Novedad => !!n && typeof n === 'object' && typeof (n as Novedad).text === 'string',
    );
    return { at, rest: ok.map((n) => ({ text: n.text, internal: n.internal === true })) };
  } catch {
    return null;
  }
}

const STRONG_YES = new Set([
  'si',
  'sip',
  'vale',
  'venga',
  'claro',
  'dale',
  'ok',
  'okay',
  'yes',
  'porfa',
  'verlos',
  'ensenamelos',
  'muestramelos',
  'pasamelos',
  'mandamelos',
  'mandalos',
  'pasalos',
  'otros',
  'demas',
  'todos',
]);
const FILLER = new Set([
  'por',
  'favor',
  'a',
  'ver',
  'quiero',
  'y',
  'los',
  'las',
  'que',
  'faltan',
  'gracias',
  'perfecto',
  'genial',
  'me',
  'ensename',
  'muestrame',
  'pasame',
  'mandame',
  'tambien',
]);
const NO = /^(?:no|nah|paso|ahora no|no hace falta|no gracias|no,? gracias|da igual)[.!\s]*$/iu;

function isYes(text: string): boolean {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 8) return false;
  return (
    words.some((w) => STRONG_YES.has(w)) && words.every((w) => STRONG_YES.has(w) || FILLER.has(w))
  );
}

/**
 * El dueño ha escrito: si hay un aviso con cambios pendientes de enseñar, este mensaje
 * es la respuesta (solo el primero tras el aviso). Devuelve lo que hay que contestar,
 * o null si el mensaje no es para esto y debe seguir su camino.
 */
export function answerPendingNovedades(
  stateDir: string,
  text: string,
  now: number = Date.now(),
): string[] | null {
  const file = pendingPath(stateDir);
  if (!existsSync(file)) return null;
  const pending = readPending(file);
  try {
    rmSync(file, { force: true });
  } catch {
    // Si no se puede borrar, como mucho se ofrecería otra vez.
  }
  if (!pending || !pending.rest.length) return null;
  if (now - pending.at > NOVEDADES_ANSWER_WINDOW_MS || now < pending.at - 60_000) return null;
  const t = (text ?? '').trim();
  if (NO.test(t)) return ['Vale, sin problema.'];
  if (!isYes(t)) return null;
  return novedadesChunks(pending.rest);
}
