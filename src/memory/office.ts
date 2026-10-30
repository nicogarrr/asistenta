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
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
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

/**
 * Everything below scans the XML in ONE linear pass with indexOf and never uses a regex that
 * can rescan to the end of the input per failed match: the parts are attacker-controlled and
 * a quadratic pattern on 20 MB freezes the whole daemon (this runs synchronously). On top of
 * the linear scan, every loop checks a hard time budget and gives up with an honest error.
 */
export const OFFICE_TIME_BUDGET_MS = 5_000;
const MAX_CELLS = 200_000;
const MAX_SHARED = 200_000;

class Budget {
  private n = 0;
  readonly until: number;
  constructor(ms: number) {
    this.until = Date.now() + ms;
  }
  tick(): void {
    if ((++this.n & 1023) === 0 && Date.now() > this.until)
      throw new OfficeError('el documento tardó demasiado en leerse');
  }
}

const NAME_END = new Set([' ', '\t', '\n', '\r', '/', '>']);

/** Name of the tag whose `<` is at `i` (without the slash of a closing tag). */
function tagName(xml: string, i: number): { name: string; closing: boolean; end: number } | null {
  const end = xml.indexOf('>', i + 1);
  if (end < 0) return null;
  let j = i + 1;
  const closing = xml[j] === '/';
  if (closing) j++;
  let k = j;
  while (k < end && !NAME_END.has(xml[k] as string)) k++;
  return { name: xml.slice(j, k), closing, end };
}

const PARA_END = new Set(['w:p', 'a:p', 'text:p', 'text:h', 'table:table-row']);
const TAB = new Set(['w:tab', 'a:tab', 'text:tab']);
const BREAK = new Set(['w:br', 'a:br', 'text:line-break']);
/**
 * Elements whose content is NOT the document's current text: text deleted with
 * track changes (`w:delText`), the old copy of moved text (`w:moveFrom`), field
 * codes such as `PAGE` or `HYPERLINK "https://…"` (`w:instrText`), and ODF's
 * record of tracked changes. Reading them showed the model words the author had
 * removed, moved text twice and field-code noise mid-sentence.
 */
const SKIP_CONTENT = new Set(['w:delText', 'w:moveFrom', 'w:instrText', 'text:tracked-changes']);

/** Text of a WordprocessingML / DrawingML / ODF fragment: paragraph ends become newlines. */
function xmlText(xml: string, b: Budget): string {
  const out: string[] = [];
  let pos = 0;
  let size = 0;
  while (pos < xml.length) {
    b.tick();
    const lt = xml.indexOf('<', pos);
    const chunk = xml.slice(pos, lt < 0 ? xml.length : lt);
    out.push(chunk);
    size += chunk.length;
    if (size > MAX_OFFICE_CHARS * 2 || lt < 0) break;
    const tag = tagName(xml, lt);
    if (!tag) break; // '<' without '>': the rest is not markup we can trust, drop it
    if (tag.closing) {
      if (PARA_END.has(tag.name)) out.push('\n');
    } else if (SKIP_CONTENT.has(tag.name) && xml[tag.end - 1] !== '/') {
      // Forward-only jump to its closing tag (they do not nest inside themselves).
      const close = xml.indexOf(`</${tag.name}>`, tag.end + 1);
      if (close < 0) break;
      pos = close + tag.name.length + 3;
      continue;
    } else if (TAB.has(tag.name)) out.push('\t');
    else if (BREAK.has(tag.name)) out.push('\n');
    pos = tag.end + 1;
  }
  return decodeEntities(out.join(''))
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Inner XML of every `<name ...>...</name>` in `xml`, scanning forward only. An element without a
 * closing tag ends the scan (the rest is hostile or cut). Self-closing elements yield ''. */
function elements(xml: string, name: string, b: Budget, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const open = `<${name}`;
  const close = `</${name}>`;
  let pos = 0;
  while (out.length < max) {
    b.tick();
    const i = xml.indexOf(open, pos);
    if (i < 0) break;
    const next = xml[i + open.length];
    if (next === undefined || !NAME_END.has(next)) {
      pos = i + open.length;
      continue;
    }
    const gt = xml.indexOf('>', i + open.length);
    if (gt < 0) break;
    if (xml[gt - 1] === '/') {
      out.push('');
      pos = gt + 1;
      continue;
    }
    const c = xml.indexOf(close, gt + 1);
    if (c < 0) break;
    out.push(xml.slice(gt + 1, c));
    pos = c + close.length;
  }
  return out;
}

/** Opening tag (`<c r="A1" t="s">`) of an element's source, for reading attributes safely. */
function attr(tagSource: string, name: string): string | undefined {
  const key = ` ${name}="`;
  const i = tagSource.indexOf(key);
  if (i < 0) return undefined;
  const j = tagSource.indexOf('"', i + key.length);
  return j < 0 ? undefined : tagSource.slice(i + key.length, j);
}

/** Elements with their opening tag, for cells (`<c t="s">`). Same forward-only scan. */
function cellsOf(xml: string, b: Budget, max: number): Array<{ open: string; inner: string }> {
  const out: Array<{ open: string; inner: string }> = [];
  let pos = 0;
  while (out.length < max) {
    b.tick();
    const i = xml.indexOf('<c', pos);
    if (i < 0) break;
    const next = xml[i + 2];
    if (next === undefined || !NAME_END.has(next)) {
      pos = i + 2;
      continue;
    }
    const gt = xml.indexOf('>', i + 2);
    if (gt < 0) break;
    const open = xml.slice(i, gt + 1);
    if (xml[gt - 1] === '/') {
      out.push({ open, inner: '' });
      pos = gt + 1;
      continue;
    }
    const c = xml.indexOf('</c>', gt + 1);
    if (c < 0) break;
    out.push({ open, inner: xml.slice(gt + 1, c) });
    pos = c + 4;
  }
  return out;
}

const num = (name: string, re: RegExp): number => Number(re.exec(name)?.[1] ?? 0);

function docxText(z: Reader, b: Budget): string {
  const parts = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];
  const headers = [...z.entries.keys()].filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  return [...parts, ...headers.sort()]
    .filter((n) => z.has(n))
    .map((n) => xmlText(z.read(n), b))
    .filter(Boolean)
    .join('\n\n');
}

function pptxText(z: Reader, b: Budget): string {
  const slides = [...z.entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, c) => num(a, /slide(\d+)/) - num(c, /slide(\d+)/));
  return slides
    .map((n, i) => {
      const t = xmlText(z.read(n), b);
      const notesName = `ppt/notesSlides/notesSlide${num(n, /slide(\d+)/)}.xml`;
      const notes = z.has(notesName) ? xmlText(z.read(notesName), b) : '';
      return t || notes ? `Diapositiva ${i + 1}\n${t}${notes ? `\nNotas: ${notes}` : ''}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const textRuns = (xml: string, b: Budget): string => decodeEntities(elements(xml, 't', b).join(''));

function xlsxText(z: Reader, b: Budget): string {
  const shared: string[] = [];
  if (z.has('xl/sharedStrings.xml')) {
    for (const si of elements(z.read('xl/sharedStrings.xml'), 'si', b, MAX_SHARED))
      shared.push(textRuns(si, b));
  }
  const sheets = [...z.entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, c) => num(a, /sheet(\d+)/) - num(c, /sheet(\d+)/));
  let rows = 0;
  let cellsSeen = 0;
  let chars = 0;
  const out: string[] = [];
  for (const [i, n] of sheets.entries()) {
    const lines: string[] = [];
    for (const row of elements(z.read(n), 'row', b, MAX_SHEET_ROWS)) {
      if (++rows > MAX_SHEET_ROWS || cellsSeen > MAX_CELLS || chars > MAX_OFFICE_CHARS) break;
      const cells: string[] = [];
      for (const c of cellsOf(row, b, MAX_CELLS - cellsSeen + 1)) {
        cellsSeen++;
        const t = attr(c.open, 't');
        const v = elements(c.inner, 'v', b, 1)[0];
        let cell = '';
        if (t === 's' && v !== undefined) cell = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') cell = textRuns(c.inner, b);
        else if (v !== undefined) cell = decodeEntities(v);
        if (cell.trim()) cells.push(cell.trim());
      }
      if (cells.length) {
        const line = cells.join('\t');
        chars += line.length;
        lines.push(line);
      }
    }
    if (lines.length) out.push(`Hoja ${i + 1}\n${lines.join('\n')}`);
    if (rows > MAX_SHEET_ROWS || cellsSeen > MAX_CELLS || chars > MAX_OFFICE_CHARS) break;
  }
  return out.join('\n\n');
}

/** Extract the text of an office document. Throws OfficeError (Spanish) when it cannot. */
export function extractOfficeText(bytes: Buffer, kind: OfficeKind): string {
  const b = new Budget(OFFICE_TIME_BUDGET_MS);
  const z = new Reader(bytes, listEntries(bytes));
  let text: string;
  switch (kind) {
    case 'docx':
      text = docxText(z, b);
      break;
    case 'pptx':
      text = pptxText(z, b);
      break;
    case 'xlsx':
      text = xlsxText(z, b);
      break;
    default:
      text = z.has('content.xml') ? xmlText(z.read('content.xml'), b) : '';
  }
  return text.slice(0, MAX_OFFICE_CHARS);
}
