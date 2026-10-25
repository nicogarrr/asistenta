import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineDeps, OcrDocError, type OcrDocResult, ocrPdf, ocrPhoto } from './engine.js';

/** Mismo tope que `telegram.downloadFile`: un bot no puede bajar más de 20 MB. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const JOB_TIMEOUT_MS = 8 * 60_000;

export type OcrMode = 'pdf' | 'md' | 'todo';

export interface OcrOutputFile {
  bytes: Buffer;
  filename: string;
}

export interface OcrJobResult {
  ok: boolean;
  /** Texto para el usuario, en español. */
  message: string;
  files: OcrOutputFile[];
}

export function parseOcrMode(args: string): OcrMode | null {
  const a = args.trim().toLowerCase();
  if (a === '' || a === 'pdf') return 'pdf';
  if (a === 'md' || a === 'markdown') return 'md';
  if (a === 'todo' || a === 'todos' || a === 'ambos') return 'todo';
  return null;
}

export type InputKind = 'pdf' | 'png' | 'jpeg';

/** El tipo sale de los primeros bytes, nunca del nombre ni del MIME que declara el remitente. */
export function detectKind(bytes: Uint8Array): InputKind | null {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

/** Nombre de salida seguro y sin pisar nada: el original nunca se toca. */
export function outputName(original: string | undefined, suffix: string, ext: string): string {
  const base = (original ?? 'documento')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return `${base || 'documento'}${suffix}.${ext}`;
}

function describe(r: OcrDocResult): string {
  const parts: string[] = [];
  if (r.ocrPages) parts.push(`${r.ocrPages} reconocida${r.ocrPages > 1 ? 's' : ''} con OCR`);
  if (r.digitalPages) parts.push(`${r.digitalPages} con texto propio`);
  const empty = r.pages.filter((p) => p.source === 'vacia').length;
  if (empty) parts.push(`${empty} sin texto reconocido`);
  if (r.unreadPages) parts.push(`${r.unreadPages} sin poder leer`);
  return `Páginas: ${parts.join(', ')}.`;
}

/**
 * Un envío completo. Crea una carpeta temporal propia y la borra siempre; no guarda ni
 * indexa nada y no escribe el contenido del documento en el log.
 */
export async function runOcrJob(
  bytes: Buffer,
  meta: { name?: string },
  mode: OcrMode,
  makeDeps: (workDir: string) => EngineDeps,
  now?: () => Date,
  timeoutMs = JOB_TIMEOUT_MS,
): Promise<OcrJobResult> {
  if (bytes.length === 0) return { ok: false, message: 'El archivo está vacío.', files: [] };
  if (bytes.length > MAX_INPUT_BYTES) {
    return {
      ok: false,
      message: 'El archivo pasa de 20 MB y Telegram no me deja bajarlo.',
      files: [],
    };
  }
  const kind = detectKind(bytes);
  if (!kind) {
    return {
      ok: false,
      message:
        'Solo leo PDF, JPG y PNG. Si es otro formato (HEIC, Word, TIFF…), conviértelo antes.',
      files: [],
    };
  }
  const dir = await mkdtemp(join(tmpdir(), 'pa-ocr-'));
  const name = meta.name ?? (kind === 'pdf' ? 'documento.pdf' : 'foto');
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  try {
    const deps = { ...makeDeps(dir), shouldStop: () => stopped };
    const work =
      kind === 'pdf'
        ? ocrPdf(bytes, name, deps, now)
        : ocrPhoto(bytes, kind === 'png' ? 'image/png' : 'image/jpeg', name, deps, now);
    work.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stopped = true;
        reject(new OcrDocError('Se ha pasado el tiempo máximo (8 min) y lo he parado.'));
      }, timeoutMs);
    });
    const r = await Promise.race([work, timeout]);
    if (r.pdf === null && r.digitalPages + r.ocrPages === 0) {
      const why = r.pages.find((p) => p.reason)?.reason;
      return {
        ok: false,
        message: `No he podido leer nada de este archivo${why ? ` (${why})` : ''}. ${describe(r)}`,
        files: [],
      };
    }
    const files: OcrOutputFile[] = [];
    if (r.pdf && (mode === 'pdf' || mode === 'todo')) {
      files.push({ bytes: Buffer.from(r.pdf), filename: outputName(name, '_OCR', 'pdf') });
    }
    if (mode === 'md' || mode === 'todo') {
      files.push({ bytes: Buffer.from(r.markdown, 'utf8'), filename: outputName(name, '', 'md') });
    }
    const lines: string[] = [];
    if (r.alreadySearchable) {
      lines.push(
        'Este PDF ya tenía texto en todas las páginas: no hacía falta OCR. Te lo devuelvo igual, sin tocar.',
      );
    }
    lines.push(describe(r));
    if (r.ocrPages) {
      lines.push(
        'El OCR puede equivocarse (cifras, nombres, tildes) y no entiende tablas: revisa los datos importantes en el original.',
      );
    }
    if (r.unreadPages) lines.push('Las páginas sin leer quedan igual que en el original.');
    lines.push('Tu original sigue en este chat sin cambios.');
    return { ok: true, message: lines.join('\n'), files };
  } catch (err) {
    const msg =
      err instanceof OcrDocError
        ? err.message
        : 'Ha fallado algo al procesarlo y no he podido terminar.';
    return { ok: false, message: msg, files: [] };
  } finally {
    if (timer) clearTimeout(timer);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
