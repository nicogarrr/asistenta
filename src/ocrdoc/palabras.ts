/**
 * /ocr en palabras: cuando Nico pide el OCR sin mandar archivo, se le contesta como un amigo
 * (sin «/ocr md» ni «/ocr todo») y el archivo que mande después, o una frase corta con el
 * archivo («hazlo buscable», «pásamelo a texto»), arranca el mismo trabajo que el pie «/ocr».
 */
import { isPdfAttachment } from '../pdfmd/chat-intent.js';
import type { OcrMode } from './job.js';

/** Respuesta a «/ocr» sin archivo. */
export const OCR_SIN_ARCHIVO =
  'Mándame el PDF o la foto y te lo devuelvo como PDF con el texto seleccionable y buscable. Si prefieres solo el texto, dímelo al mandarlo («pásamelo a texto»), o «las dos cosas».';

export interface OcrMessage {
  text?: string;
  photoFileId?: string;
  documentFileId?: string;
  documentMimeType?: string;
  documentName?: string;
}

/** Una frase con el archivo; más larga ya es otra petición y la lee el modelo. */
const MAX_PHRASE = 70;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:«»"“”()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isImageAttachment(m: OcrMessage): boolean {
  if (m.photoFileId) return true;
  if (!m.documentFileId) return false;
  const mime = m.documentMimeType?.toLowerCase() ?? '';
  if (mime === 'image/png' || mime === 'image/jpeg') return true;
  return /\.(png|jpe?g)$/i.test(m.documentName?.trim() ?? '');
}

const SEARCHABLE =
  /\b(buscable|buscables|seleccionable|seleccionables|que se pueda (buscar|copiar|seleccionar)|que pueda (buscar|copiar|seleccionar))\b/;
const TO_TEXT =
  /\b(a texto|el texto|solo (el )?texto|a markdown|a md|transcribe|transcribemelo|transcribelo)\b/;
const BOTH = /\b(las dos cosas|ambas cosas|los dos|ambos|todo)\b/;
const NEGATED = /\b(no|nunca|sin) (lo |me lo |le )?(hagas|pases|conviertas|saques)\b/;

/**
 * El modo de OCR que pide el mensaje, o `null` si no es una petición de OCR.
 * `waiting` es que antes pidió «/ocr» sin archivo: entonces vale el archivo solo (sin pie)
 * o con «pásamelo a texto» / «las dos cosas»; sin espera, solo «hazlo buscable» lo arranca
 * (lo demás con una foto lo sigue leyendo el modelo).
 */
export function ocrWordsMode(m: OcrMessage, waiting: boolean): OcrMode | null {
  const pdf = isPdfAttachment(m);
  if (!pdf && !isImageAttachment(m)) return null;
  const raw = m.text?.trim() ?? '';
  if (raw.startsWith('/') || raw.length > MAX_PHRASE) return null;
  const t = normalize(raw);
  if (NEGATED.test(t)) return null;
  const searchable = SEARCHABLE.test(t);
  const toText = TO_TEXT.test(t);
  if ((searchable && toText) || (waiting && BOTH.test(t))) return 'todo';
  if (searchable) return 'pdf';
  if (waiting && toText) return 'md';
  if (waiting && t === '') return 'pdf';
  return null;
}

/** Recuerda, por chat y unos minutos, que se pidió «/ocr» sin archivo. */
export function createOcrEspera(ttlMs = 10 * 60_000, now: () => number = Date.now) {
  const until = new Map<string, number>();
  return {
    arm(chatId: string | number): void {
      until.set(String(chatId), now() + ttlMs);
    },
    isArmed(chatId: string | number): boolean {
      const t = until.get(String(chatId));
      if (t === undefined) return false;
      if (now() > t) {
        until.delete(String(chatId));
        return false;
      }
      return true;
    },
    clear(chatId: string | number): void {
      until.delete(String(chatId));
    },
  };
}
