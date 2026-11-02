import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import { log } from '../log.js';
import type { PageProgress } from '../pdfmd/progress.js';
import type { OcrResult } from '../screen/ocr.js';

/**
 * PDF o foto -> PDF con texto reconocible (buscable y copiable) + Markdown.
 *
 * Todo local y sin coste: el texto de las páginas escaneadas sale del OCR que ya trae
 * Windows (el mismo de `src/screen/ocr.ts`), y la capa de texto se añade con `pdf-lib`
 * (MIT, JS puro) SOBRE la página original, que no se toca ni se rasteriza de nuevo.
 *
 * Qué hace con cada página de un PDF:
 * - Tiene texto propio (PDF digital): se deja tal cual y su texto va al Markdown.
 * - No tiene texto (escaneada): se renderiza a PNG, se reconoce y se superpone el texto
 *   reconocido con opacidad 0 (invisible, pero seleccionable y buscable).
 * - Falla el render o el OCR: la página queda como estaba y el informe dice cuál y por qué.
 *
 * Límites honestos que el resultado repite al usuario: el OCR se equivoca (cifras, tildes,
 * nombres), no entiende tablas ni columnas, y la capa invisible se coloca por LÍNEA, así
 * que seleccionar una palabra concreta puede resaltar un tramo algo distinto.
 */
export const MAX_PAGES = 40;
export const MIN_DIGITAL_CHARS = 20;
/** Tope de píxeles de una foto antes de decodificarla (evita imágenes-bomba). */
export const MAX_IMAGE_PIXELS = 60_000_000;
/** Tope de superficie de una página PDF en puntos por lado. */
const MAX_PAGE_POINTS = 14_400;

export type PageSource = 'digital' | 'ocr' | 'vacia' | 'sin_leer';

export interface PageReport {
  page: number;
  source: PageSource;
  chars: number;
  reason?: string;
  /** Caracteres reconocidos que no caben en la capa buscable del PDF (emoji, cirílico…). */
  droppedChars?: number;
}

export interface EngineDeps {
  /** Texto propio de cada página (vacío si es una imagen). */
  digitalPages(bytes: Uint8Array): Promise<string[]>;
  /** Renderiza la página (0-based) del PDF a un PNG. Undefined si no hay renderizador. */
  renderPage?: (pdfPath: string, pageIndex: number, outPng: string) => Promise<void>;
  /** OCR de una imagen (PNG/JPEG). Undefined si no hay motor de OCR. */
  ocr?: (imagePath: string) => Promise<OcrResult>;
  /** Carpeta de trabajo creada y borrada por quien llama. */
  workDir: string;
  /** Por qué no hay OCR (para decirlo), si no lo hay. */
  noOcrReason?: string;
  /** Cancelación cooperativa: se mira antes de cada página. */
  shouldStop?: () => boolean;
  /** Páginas ya reconocidas en un intento anterior (PDFs largos que se cortaron). */
  progress?: PageProgress;
}

export interface OcrDocResult {
  /** PDF final. Null si no se pudo leer ninguna página. */
  pdf: Uint8Array | null;
  markdown: string;
  pages: PageReport[];
  /** Páginas sin texto propio que se reconocieron con OCR. */
  ocrPages: number;
  digitalPages: number;
  unreadPages: number;
  /** Total de caracteres reconocidos que NO están en la capa buscable del PDF. */
  droppedChars: number;
  /** Ninguna página necesitaba OCR: el PDF ya tenía texto en todas. */
  alreadySearchable: boolean;
}

export class OcrDocError extends Error {}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
}

/** Letras que WinAnsi (Helvetica estándar) puede codificar; el resto se descarta sin romper. */
function winAnsiSafe(font: PDFFont, text: string): { text: string; dropped: number } {
  let out = '';
  let dropped = 0;
  for (const ch of text.replace(/\s+/g, ' ')) {
    try {
      font.widthOfTextAtSize(ch, 1);
      out += ch;
    } catch {
      // carácter fuera de WinAnsi (p. ej. emoji, cirílico): no entra en la capa buscable,
      // pero se cuenta para avisar de que la búsqueda en el PDF quedará incompleta.
      dropped++;
    }
  }
  return { text: out.trim(), dropped };
}

function overlayLines(
  page: PDFPage,
  font: PDFFont,
  ocr: OcrResult,
): { placed: number; dropped: number } {
  const { width: pw, height: ph } = page.getSize();
  if (ocr.width <= 0 || ocr.height <= 0) return { placed: 0, dropped: 0 };
  const sx = pw / ocr.width;
  const sy = ph / ocr.height;
  let placed = 0;
  let dropped = 0;
  for (const line of ocr.lines) {
    const safe = winAnsiSafe(font, line.text);
    dropped += safe.dropped;
    const text = safe.text;
    if (!text) continue;
    const base = font.widthOfTextAtSize(text, 1);
    const hPt = line.height * sy;
    const wPt = line.width * sx;
    if (base <= 0 || hPt <= 0 || wPt <= 0) continue;
    // Tamaño para que el ancho de la línea coincida con el reconocido; acotado para que un
    // renglón con un solo carácter no salga gigante.
    const size = Math.min(Math.max(wPt / base, hPt * 0.5), hPt * 1.6);
    page.drawText(text, {
      x: line.x * sx,
      y: ph - (line.y + line.height) * sy + hPt * 0.2,
      size,
      font,
      opacity: 0,
    });
    placed++;
  }
  return { placed, dropped };
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Una línea de título segura: el nombre del archivo viene de fuera y no manda en el formato. */
function safeTitle(name: string): string {
  return (
    name
      .replace(/\.[A-Za-z0-9]{1,5}$/, '')
      .replace(/[\r\n#*_`<>[\]|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'Documento'
  );
}

export function buildMarkdown(opts: {
  name: string;
  at: Date;
  texts: string[];
  pages: PageReport[];
}): string {
  const out: string[] = [
    `# ${safeTitle(opts.name)}`,
    '',
    `> Convertido: ${opts.at.toISOString().slice(0, 16).replace('T', ' ')} UTC · Páginas: ${opts.pages.length}`,
    '> Aviso: parte del texto se ha reconocido automáticamente (OCR) y puede tener errores en cifras, nombres y tildes. No entiende tablas ni columnas, y el orden de lectura no está garantizado. Compruébalo con el original antes de fiarte de un dato.',
    '',
  ];
  for (const p of opts.pages) {
    const label =
      p.source === 'digital'
        ? `texto del propio PDF${p.reason ? `: ${p.reason}` : ''}`
        : p.source === 'ocr'
          ? 'reconocido por OCR'
          : p.source === 'vacia'
            ? 'sin texto reconocido'
            : `no se pudo leer${p.reason ? `: ${p.reason}` : ''}`;
    out.push('---', '', `## Página ${p.page} (${label})`, '');
    const text = opts.texts[p.page - 1] ?? '';
    if (text) out.push(text, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function summarise(
  pages: PageReport[],
): Pick<OcrDocResult, 'ocrPages' | 'digitalPages' | 'unreadPages' | 'droppedChars'> {
  return {
    droppedChars: pages.reduce((n, p) => n + (p.droppedChars ?? 0), 0),
    ocrPages: pages.filter((p) => p.source === 'ocr').length,
    digitalPages: pages.filter((p) => p.source === 'digital').length,
    unreadPages: pages.filter((p) => p.source === 'sin_leer').length,
  };
}

export async function ocrPdf(
  bytes: Uint8Array,
  name: string,
  deps: EngineDeps,
  now: () => Date = () => new Date(),
): Promise<OcrDocResult> {
  // pdf-lib tarda en cargarse: solo se carga al tratar un documento, no al arrancar.
  const pdfLib = await import('pdf-lib');
  let doc: PDFDocument;
  let total: number;
  try {
    doc = await pdfLib.PDFDocument.load(bytes);
    total = doc.getPageCount();
  } catch (err) {
    if (/encrypt/i.test(errMsg(err)))
      throw new OcrDocError('El PDF está protegido con contraseña; no lo abro.');
    // The library's own words (English, offsets) go to the log, not to the chat.
    log.warn('ocrdoc: pdf load failed', { err: errMsg(err) });
    throw new OcrDocError(
      'No he podido abrir el PDF: parece dañado o no es un PDF de verdad. Prueba a guardarlo otra vez y mándamelo.',
    );
  }
  if (total === 0) throw new OcrDocError('El PDF no tiene páginas.');
  if (total > MAX_PAGES) {
    throw new OcrDocError(
      `El PDF tiene ${total} páginas y el máximo por envío es ${MAX_PAGES}. Pártelo y mándalo por trozos.`,
    );
  }
  let digital: string[];
  try {
    digital = await deps.digitalPages(bytes);
  } catch (err) {
    log.warn('ocrdoc: pdf text read failed', { err: errMsg(err) });
    throw new OcrDocError(
      'No he podido leer el texto del PDF. Prueba a guardarlo otra vez o mándamelo como fotos.',
    );
  }

  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const reports: PageReport[] = [];
  const texts: string[] = [];
  const pdfPath = join(deps.workDir, 'entrada.pdf');
  let pdfWritten = false;
  let overlaid = 0;

  for (let i = 0; i < total; i++) {
    if (deps.shouldStop?.()) throw new OcrDocError('Cancelado.');
    const own = tidy(digital[i] ?? '');
    if (own.replace(/\s/g, '').length >= MIN_DIGITAL_CHARS) {
      reports.push({ page: i + 1, source: 'digital', chars: own.length });
      texts.push(own);
      continue;
    }
    // Escaneada (o casi vacía): necesita render + OCR.
    texts.push('');
    // A short digital fragment is real evidence, even when it is not enough
    // to skip OCR for the rest of the page. Never discard it on fallback.
    const retainDigital = (reason: string): boolean => {
      if (!own) return false;
      texts[i] = own;
      reports.push({
        page: i + 1,
        source: 'digital',
        chars: own.length,
        reason: `texto parcial; ${reason}`,
      });
      return true;
    };
    if (!deps.renderPage || !deps.ocr) {
      if (retainDigital(deps.noOcrReason ?? 'no hay OCR disponible')) continue;
      reports.push({
        page: i + 1,
        source: 'sin_leer',
        chars: 0,
        reason: deps.noOcrReason ?? 'no hay OCR disponible',
      });
      continue;
    }
    const page = doc.getPage(i);
    const { width: pw, height: ph } = page.getSize();
    if (page.getRotation().angle % 360 !== 0) {
      if (retainDigital('página girada (OCR no soportado)')) continue;
      // Windows renderiza ya girada y la capa se colocaría torcida: mejor no inventarla.
      reports.push({
        page: i + 1,
        source: 'sin_leer',
        chars: 0,
        reason: 'página girada (no soportada todavía)',
      });
      continue;
    }
    if (!(pw > 0 && ph > 0) || pw > MAX_PAGE_POINTS || ph > MAX_PAGE_POINTS) {
      if (retainDigital('tamaño de página fuera de rango para OCR')) continue;
      reports.push({
        page: i + 1,
        source: 'sin_leer',
        chars: 0,
        reason: 'tamaño de página fuera de rango',
      });
      continue;
    }
    try {
      let result = deps.progress?.get(i);
      if (!result) {
        if (!pdfWritten) {
          await writeFile(pdfPath, bytes);
          pdfWritten = true;
        }
        const png = join(deps.workDir, `p${i + 1}.png`);
        await deps.renderPage(pdfPath, i, png);
        result = await deps.ocr(png);
        await deps.progress?.put(i, result);
      }
      const text = tidy(result.text ?? '');
      if (!text) {
        if (retainDigital('OCR sin texto adicional reconocido')) continue;
        reports.push({ page: i + 1, source: 'vacia', chars: 0 });
        continue;
      }
      const o = overlayLines(page, font, result);
      overlaid += o.placed;
      texts[i] = text;
      reports.push({
        page: i + 1,
        source: 'ocr',
        chars: text.length,
        droppedChars: o.dropped,
      });
    } catch (err) {
      if (retainDigital(`OCR no disponible: ${errMsg(err)}`)) continue;
      reports.push({ page: i + 1, source: 'sin_leer', chars: 0, reason: errMsg(err) });
    }
  }

  const counts = summarise(reports);
  const readable = counts.ocrPages + counts.digitalPages;
  const md = buildMarkdown({ name, at: now(), texts, pages: reports });
  if (readable === 0 && !reports.some((r) => r.source === 'vacia')) {
    return { pdf: null, markdown: md, pages: reports, ...counts, alreadySearchable: false };
  }
  const pdf = counts.ocrPages > 0 && overlaid > 0 ? await doc.save() : bytes;
  return {
    pdf,
    markdown: md,
    pages: reports,
    ...counts,
    alreadySearchable:
      counts.ocrPages === 0 &&
      counts.unreadPages === 0 &&
      counts.digitalPages === total &&
      !reports.some((r) => r.source === 'digital' && r.reason),
  };
}

/** Ancho y alto de un PNG o JPEG leyendo solo la cabecera (sin decodificar nada). */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.subarray(1, 4).toString('latin1') === 'PNG') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1] as number;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** PNG o JPEG a un PDF de una página con el texto reconocido por encima. */
export async function ocrPhoto(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg',
  name: string,
  deps: EngineDeps,
  now: () => Date = () => new Date(),
): Promise<OcrDocResult> {
  if (!deps.ocr) {
    throw new OcrDocError(
      deps.noOcrReason ? `No hay OCR disponible: ${deps.noOcrReason}` : 'No hay OCR disponible.',
    );
  }
  const size = imageSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new OcrDocError('No he podido abrir la imagen (cabecera no válida).');
  }
  if (size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new OcrDocError(
      `La imagen es demasiado grande (${size.width}x${size.height}). Reduce su tamaño y vuelve a mandarla.`,
    );
  }
  const pdfLib = await import('pdf-lib');
  const doc = await pdfLib.PDFDocument.create();
  let image: Awaited<ReturnType<PDFDocument['embedPng']>>;
  try {
    image = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch (err) {
    log.warn('ocrdoc: image load failed', { err: errMsg(err) });
    throw new OcrDocError(
      'No he podido abrir la imagen: parece dañada. Prueba a mandarla otra vez como foto.',
    );
  }
  // 0,75 pt por píxel (96 dpi): una foto de móvil sale como página grande pero proporcionada.
  const page = doc.addPage([image.width * 0.75, image.height * 0.75]);
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
  const file = join(deps.workDir, mime === 'image/png' ? 'foto.png' : 'foto.jpg');
  await writeFile(file, bytes);
  const reports: PageReport[] = [];
  let text = '';
  try {
    const result = await deps.ocr(file);
    text = tidy(result.text ?? '');
    if (text) {
      const o = overlayLines(page, font, result);
      reports.push({ page: 1, source: 'ocr', chars: text.length, droppedChars: o.dropped });
    } else {
      reports.push({ page: 1, source: 'vacia', chars: 0 });
    }
  } catch (err) {
    reports.push({ page: 1, source: 'sin_leer', chars: 0, reason: errMsg(err) });
  }
  const counts = summarise(reports);
  const md = buildMarkdown({ name, at: now(), texts: [text], pages: reports });
  return {
    pdf: counts.ocrPages > 0 ? await doc.save() : null,
    markdown: md,
    pages: reports,
    ...counts,
    alreadySearchable: false,
  };
}
