import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canExtract, extractText } from '../src/memory/docs.js';
import { extractOfficeText, OfficeError, officeKind } from '../src/memory/office.js';

// Mismo zip mínimo que test/memory-office.test.ts (sin dependencias).
interface ZipOpts {
  /** Lie about the uncompressed size in the central directory. */
  declaredSize?: Record<string, number>;
  encrypted?: string[];
  stored?: string[];
}

function makeZip(files: Record<string, string | Buffer>, opts: ZipOpts = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const stored = opts.stored?.includes(name) ?? false;
    const data = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const flags = opts.encrypted?.includes(name) ? 1 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(opts.declaredSize?.[name] ?? raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest>
<item id="c2" href="Text/cap2.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="Text/cap1.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="estilo.css" media-type="text/css"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
const cap = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>NO</title><style>p{color:red}</style></head><body><h1>${title}</h1>${body}</body></html>`;

const book = (files: Record<string, string> = {}) =>
  makeZip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': OPF,
    'OEBPS/Text/cap1.xhtml': cap(
      'Capítulo 1',
      '<p>En un lugar de la Mancha,&nbsp;de cuyo nombre</p><p>no quiero acordarme.</p>',
    ),
    'OEBPS/Text/cap2.xhtml': cap(
      'Capítulo 2',
      '<p>Fin &amp; adiós<br/>línea dos</p><script>alert(1)</script>',
    ),
    ...files,
  });

describe('EPUB: «léeme este libro» por Telegram', () => {
  it('se reconoce por tipo o por extensión', () => {
    expect(officeKind('application/epub+zip')).toBe('epub');
    expect(officeKind('application/octet-stream', 'Quijote.EPUB')).toBe('epub');
    expect(canExtract(undefined, 'libro.epub')).toBe(true);
  });

  it('lee los capítulos en el orden de lectura, sin cabeceras, estilos ni scripts', () => {
    const text = extractOfficeText(book(), 'epub');
    expect(text.indexOf('Capítulo 1')).toBeLessThan(text.indexOf('Capítulo 2'));
    expect(text).toContain('En un lugar de la Mancha, de cuyo nombre\n');
    expect(text).toContain('no quiero acordarme.');
    expect(text).toContain('Fin & adiós\nlínea dos');
    expect(text).not.toMatch(/NO|color:red|alert/);
  });

  it('sin índice usable, lee los capítulos por nombre', () => {
    const text = extractOfficeText(book({ 'META-INF/container.xml': '<container/>' }), 'epub');
    expect(text).toContain('Capítulo 1');
    expect(text).toContain('Capítulo 2');
  });

  it('un href con % mal puesto no tira la lectura: manda el respaldo por nombre', () => {
    const opfMal = OPF.replace('Text/cap1.xhtml', 'Text/cap%c3%28.xhtml');
    const text = extractOfficeText(book({ 'OEBPS/content.opf': opfMal }), 'epub');
    expect(text).toContain('Capítulo 1');
    expect(text).toContain('Capítulo 2');
  });

  it('un zip sin capítulos se rechaza con un motivo en castellano', () => {
    const empty = makeZip({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': CONTAINER,
    });
    expect(() => extractOfficeText(empty, 'epub')).toThrow(OfficeError);
    expect(() => extractOfficeText(empty, 'epub')).toThrow(/no tiene capítulos/);
  });

  it('extractText (el que usa la memoria de documentos) también lo lee', async () => {
    const text = await extractText(book(), 'application/epub+zip');
    expect(text).toContain('no quiero acordarme.');
  });
});
