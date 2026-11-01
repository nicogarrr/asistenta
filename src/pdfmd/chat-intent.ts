/**
 * Frases naturales con un PDF adjunto: «pásame este PDF a texto» arranca el mismo trabajo
 * que el pie «/ocr md» (texto en Markdown, tablas comprobadas sin IA). Idea de pdf2md
 * (https://github.com/Ntizar/pdf2md, MIT). Solo frases cortas y claras: si hay duda, la
 * conversación sigue como siempre y el modelo responde.
 */

export interface PdfMessage {
  text?: string;
  documentFileId?: string;
  documentMimeType?: string;
  documentName?: string;
}

/** Más largo que esto ya no es «pásalo a texto», es otra petición sobre el PDF. */
const MAX_PHRASE = 70;

/** Lo que manda el usuario declara que es un PDF (el trabajo luego mira los bytes). */
export function isPdfAttachment(m: PdfMessage): boolean {
  if (!m.documentFileId) return false;
  const mime = m.documentMimeType?.toLowerCase() ?? '';
  if (mime === 'application/pdf') return true;
  return /\.pdf$/i.test(m.documentName?.trim() ?? '');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:«»"“”()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONVERT =
  /\b(pasa|pasame|pasalo|pasamelo|pasar|pasarme|pasarmelo|pasarlo|convierte|conviertelo|conviertemelo|convertir|convertirlo|transforma|transformalo|ponmelo|ponlo)\b.*\ba (texto|markdown|md)\b/;
const EXTRACT =
  /\b(saca|sacame|sacar|sacarme|extrae|extraeme|extraer|extraerme|copia|copiame|dame)\b.*\b(el )?texto\b/;
const TRANSCRIBE = /\b(transcribe|transcribemelo|transcribelo|transcribir|transcribirlo)\b/;
const OCR = /\b(hazle|haz|hacer|hacerle|pasale|pasa|pasarle) (el |un )?ocr\b/;
const NEGATED =
  /\b(no|nunca|sin) (lo |me lo |le )?(pases|conviertas|saques|extraigas|transcribas|hagas)\b/;

/**
 * `'md'` cuando el mensaje es un PDF con una frase de «pásalo a texto»; `null` en el resto
 * (sin PDF, sin frase, frase negada o una petición más larga que debe leer el modelo).
 */
export function pdfToTextIntent(m: PdfMessage): 'md' | null {
  if (!isPdfAttachment(m)) return null;
  const raw = m.text?.trim() ?? '';
  if (!raw || raw.startsWith('/') || raw.length > MAX_PHRASE) return null;
  const t = normalize(raw);
  if (NEGATED.test(t)) return null;
  if (CONVERT.test(t) || EXTRACT.test(t) || TRANSCRIBE.test(t) || OCR.test(t)) return 'md';
  return null;
}

const SUMMARY =
  /\b(resume|resumeme|resumelo|resumemelo|resumen|resumir|resumirlo|resumirmelo|de que va|que dice|que pone|leeme|leemelo|leelo|lee este|lee esto)\b/;

/**
 * «resume este PDF» (o «¿qué dice?», «léemelo») con un PDF adjunto: si el PDF es escaneado,
 * primero se lee con el OCR local y luego contesta el modelo.
 */
export function pdfSummaryIntent(m: PdfMessage): boolean {
  if (!isPdfAttachment(m)) return false;
  const raw = m.text?.trim() ?? '';
  if (!raw || raw.startsWith('/') || raw.length > MAX_PHRASE) return false;
  return SUMMARY.test(normalize(raw));
}
