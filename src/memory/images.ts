import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';
import type { OcrResult } from '../screen/ocr.js';

/**
 * Photos and images forwarded to the assistant: read the text that is visible in them
 * with the OCR that ships in Windows (local, €0) so it can be indexed and found later.
 * Only text is read: a photo of a beach indexes nothing and the caller says so. The
 * image itself is never stored; the temp copy needed by the OCR engine is deleted in a
 * `finally`, whatever happens.
 */

/** Formats Windows' BitmapDecoder reads reliably. Anything else is refused out loud. */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/tiff': 'tif',
};
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Text kept from one image; the doc store caps further. */
export const MAX_OCR_CHARS = 20_000;

export type ImageOcrOutcome =
  | { status: 'ok'; text: string; truncated: boolean }
  | { status: 'no-text' }
  | { status: 'unavailable'; reason: string };

export interface ImageOcrDeps {
  platform?: NodeJS.Platform;
  ocrAvailable: () => Promise<boolean>;
  ocrImage: (path: string) => Promise<OcrResult>;
  /** Where the temporary copy lives; defaults to the OS temp dir. */
  tempRoot?: string;
}

export function imageExtension(mimeType?: string): string | null {
  return (mimeType && EXT_BY_MIME[mimeType.toLowerCase()]) || null;
}

export async function ocrImageBytes(
  bytes: Buffer,
  mimeType: string | undefined,
  deps: ImageOcrDeps,
): Promise<ImageOcrOutcome> {
  if ((deps.platform ?? process.platform) !== 'win32')
    return { status: 'unavailable', reason: 'el OCR de fotos solo funciona en Windows' };
  const ext = imageExtension(mimeType);
  if (!ext)
    return {
      status: 'unavailable',
      reason: `no sé leer imágenes ${mimeType ?? 'de tipo desconocido'} (solo JPG, PNG, BMP, GIF y TIFF)`,
    };
  if (bytes.length === 0) return { status: 'unavailable', reason: 'la imagen está vacía' };
  if (bytes.length > MAX_IMAGE_BYTES)
    return { status: 'unavailable', reason: 'la imagen pesa más de 20 MB' };
  if (!(await deps.ocrAvailable().catch(() => false)))
    return { status: 'unavailable', reason: 'Windows no tiene un idioma de OCR instalado' };
  const dir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'mem-img-'));
  try {
    const file = join(dir, `i.${ext}`);
    writeFileSync(file, bytes);
    const res = await deps.ocrImage(file);
    const text = res.lines
      .map((l) => l.text)
      .join('\n')
      .replace(/[^\S\n]+/g, ' ')
      .trim();
    if (!text) return { status: 'no-text' };
    return text.length > MAX_OCR_CHARS
      ? { status: 'ok', text: text.slice(0, MAX_OCR_CHARS), truncated: true }
      : { status: 'ok', text, truncated: false };
  } catch (err) {
    log.warn('image ocr failed', { err: String(err) });
    return { status: 'unavailable', reason: 'el OCR falló al leer la imagen' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Note for the model: what happened to a photo, with the honest limits. */
export function imageNote(
  label: string,
  outcome: ImageOcrOutcome,
  indexed: { chars: number; truncated: boolean } | null,
): string {
  if (outcome.status === 'unavailable') return `[${label}: no se indexó: ${outcome.reason}.]`;
  if (outcome.status === 'no-text' || !indexed)
    return `[${label}: no tenía texto legible; no se indexó nada (solo se lee el texto visible, no lo que se ve en la imagen).]`;
  const partial =
    outcome.truncated || indexed.truncated ? ' PARCIALMENTE (el texto era demasiado largo)' : '';
  return `[${label}: texto leído con OCR e indexado${partial} en la memoria documental (${indexed.chars} caracteres). El OCR puede equivocarse y solo cubre el texto visible, no lo que se ve en la imagen. Úsalo con la herramienta documents cuando pregunte por él.]`;
}
