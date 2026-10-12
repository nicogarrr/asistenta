import { inflateRawSync } from 'node:zlib';

/**
 * Minimal, dependency-free reader for the zip-based office formats (docx, xlsx, pptx and
 * the OpenDocument trio). It only ever pulls the handful of XML parts that carry text and
 * never writes anything to disk, so a hostile archive can at worst be refused.
 *
 * Anti zip-bomb limits are enforced on what is actually inflated, not on what the archive
 * declares: the central directory is attacker-controlled, so `maxOutputLength` bounds every
 * inflate and a running total bounds the whole document.
 */

export class OfficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeError';
  }
}

export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_ENTRIES = 5_000;
/** One XML part never inflates past this. */
export const MAX_PART_BYTES = 20 * 1024 * 1024;
/** All parts of one document together. */
export const MAX_TOTAL_INFLATED = 40 * 1024 * 1024;
/** Text kept from one document before the doc store applies its own caps. */
export const MAX_OFFICE_CHARS = 1_000_000;
const MAX_SHEET_ROWS = 20_000;

export const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
} as const;
export type OfficeKind = keyof typeof OFFICE_MIME;

const GENERIC_MIME = new Set(['application/octet-stream', 'application/zip', '']);

/** Kind by mime type, or by file extension when the mime type is generic. */
export function officeKind(mimeType?: string, fileName?: string): OfficeKind | null {
  const mime = (mimeType ?? '').toLowerCase();
  for (const [kind, m] of Object.entries(OFFICE_MIME)) if (mime === m) return kind as OfficeKind;
  if (GENERIC_MIME.has(mime)) {
    const ext = /\.(docx|xlsx|pptx|odt|ods|odp)$/i.exec(fileName ?? '')?.[1]?.toLowerCase();
    if (ext) return ext as OfficeKind;
  }
  return null;
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  offset: number;
  flags: number;
}

function listEntries(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length > MAX_ARCHIVE_BYTES) throw new OfficeError('el archivo pesa más de 25 MB');
  if (buf.length < 22) throw new OfficeError('el archivo no es un documento válido');
  // End of central directory: scan back (a comment can follow it, max 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new OfficeError('el archivo no es un documento válido (zip dañado)');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new OfficeError('zip64 no soportado');
  if (total > MAX_ENTRIES) throw new OfficeError('el archivo tiene demasiadas partes');
  if (cdOffset + cdSize > eocd) throw new OfficeError('el archivo no es un documento válido');
  const out = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new OfficeError('el archivo no es un documento válido (directorio dañado)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length)
      throw new OfficeError('el archivo no es un documento válido');
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.set(name, { name, method, compSize, size, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

class Reader {
  inflated = 0;
  readonly buf: Buffer;
  readonly entries: Map<string, ZipEntry>;
  constructor(buf: Buffer, entries: Map<string, ZipEntry>) {
    this.buf = buf;
    this.entries = entries;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  read(name: string): string {
    const e = this.entries.get(name);
    if (!e) return '';
    if (e.flags & 1) throw new OfficeError('el documento está protegido con contraseña');
    if (e.size > MAX_PART_BYTES)
      throw new OfficeError('una parte del documento es demasiado grande');
    if (e.offset + 30 > this.buf.length || this.buf.readUInt32LE(e.offset) !== 0x04034b50)
      throw new OfficeError('el archivo no es un documento válido (cabecera dañada)');
    const nameLen = this.buf.readUInt16LE(e.offset + 26);
    const extraLen = this.buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const end = start + e.compSize;
    if (end > this.buf.length) throw new OfficeError('el archivo está cortado o dañado');
    const raw = this.buf.subarray(start, end);
    let data: Buffer;
    if (e.method === 0) {
      data = raw;
    } else if (e.method === 8) {
      try {
        // The declared size is only a hint: the cap below is what actually protects us.
        data = inflateRawSync(raw, { maxOutputLength: Math.min(MAX_PART_BYTES, e.size + 1024) });
      } catch {
        throw new OfficeError('una parte del documento está dañada o es demasiado grande');
      }
    } else {
      throw new OfficeError('método de compresión no soportado');
    }
    this.inflated += data.length;
    if (this.inflated > MAX_TOTAL_INFLATED)
      throw new OfficeError('el documento es demasiado grande al descomprimirlo');
    return data.toString('utf8');
  }
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Only the five predefined entities and numeric references: nothing is ever expanded or fetched. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return ENT[e] ?? '';
    const code = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isInteger(code) &&
      code > 8 &&
      code <= 0x10ffff &&
      !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : '';
  });
}

/** Text of a WordprocessingML / DrawingML / ODF fragment: paragraph ends become newlines. */
function xmlText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<(?:w|a|text):(?:tab)\b[^>]*\/>/g, '\t')
      .replace(/<(?:w:br|a:br|text:line-break)\b[^>]*\/>/g, '\n')
      .replace(/<\/(?:w:p|a:p|text:p|text:h|table:table-row)>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const num = (name: string, re: RegExp): number => Number(re.exec(name)?.[1] ?? 0);

function docxText(z: Reader): string {
  const parts = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];
  const headers = [...z.entries.keys()].filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  return [...parts, ...headers.sort()]
    .filter((n) => z.has(n))
    .map((n) => xmlText(z.read(n)))
    .filter(Boolean)
    .join('\n\n');
}

function pptxText(z: Reader): string {
  const slides = [...z.entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => num(a, /slide(\d+)/) - num(b, /slide(\d+)/));
  return slides
    .map((n, i) => {
      const t = xmlText(z.read(n));
      const notesName = `ppt/notesSlides/notesSlide${num(n, /slide(\d+)/)}.xml`;
      const notes = z.has(notesName) ? xmlText(z.read(notesName)) : '';
      return t || notes ? `Diapositiva ${i + 1}\n${t}${notes ? `\nNotas: ${notes}` : ''}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function xlsxText(z: Reader): string {
  const shared: string[] = [];
  if (z.has('xl/sharedStrings.xml')) {
    for (const si of z.read('xl/sharedStrings.xml').match(/<si\b[\s\S]*?<\/si>/g) ?? [])
      shared.push(
        decodeEntities(
          (si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [])
            .map((t) => t.replace(/<[^>]*>/g, ''))
            .join(''),
        ),
      );
  }
  const sheets = [...z.entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => num(a, /sheet(\d+)/) - num(b, /sheet(\d+)/));
  let rows = 0;
  const out: string[] = [];
  for (const [i, n] of sheets.entries()) {
    const lines: string[] = [];
    for (const row of z.read(n).match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      if (++rows > MAX_SHEET_ROWS) break;
      const cells: string[] = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const t = /\bt="(\w+)"/.exec(c)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        let cell = '';
        if (t === 's' && v !== undefined) cell = shared[Number(v)] ?? '';
        else if (t === 'inlineStr')
          cell = decodeEntities(
            (c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [])
              .map((x) => x.replace(/<[^>]*>/g, ''))
              .join(''),
          );
        else if (v !== undefined) cell = decodeEntities(v);
        if (cell.trim()) cells.push(cell.trim());
      }
      if (cells.length) lines.push(cells.join('\t'));
    }
    if (lines.length) out.push(`Hoja ${i + 1}\n${lines.join('\n')}`);
    if (rows > MAX_SHEET_ROWS) break;
  }
  return out.join('\n\n');
}

/** Extract the text of an office document. Throws OfficeError (Spanish) when it cannot. */
export function extractOfficeText(bytes: Buffer, kind: OfficeKind): string {
  const z = new Reader(bytes, listEntries(bytes));
  let text: string;
  switch (kind) {
    case 'docx':
      text = docxText(z);
      break;
    case 'pptx':
      text = pptxText(z);
      break;
    case 'xlsx':
      text = xlsxText(z);
      break;
    default:
      text = z.has('content.xml') ? xmlText(z.read('content.xml')) : '';
  }
  return text.slice(0, MAX_OFFICE_CHARS);
}
