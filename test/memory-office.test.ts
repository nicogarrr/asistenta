import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { canExtract, DocMemory } from '../src/memory/docs.js';
import {
  decodeEntities,
  extractOfficeText,
  MAX_ENTRIES,
  OFFICE_MIME,
  officeKind,
} from '../src/memory/office.js';
import { createDocsTool } from '../src/tools/docs.js';

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

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string, extra: Record<string, string> = {}): Buffer =>
  makeZip({
    'word/document.xml': `<w:document ${W}><w:body>${body}</w:body></w:document>`,
    ...extra,
  });

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mo-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mem = (): { m: DocMemory; dir: string } => {
  const dir = tmp();
  return { m: new DocMemory({ dbPath: join(dir, 'd.sqlite'), directory: join(dir, 'txt') }), dir };
};
const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');

describe('tipo de archivo', () => {
  it('por mime, y por extensión si el mime es genérico', () => {
    expect(officeKind(OFFICE_MIME.docx)).toBe('docx');
    expect(officeKind('application/octet-stream', 'Contrato.XLSX')).toBe('xlsx');
    expect(officeKind('application/zip', 'a.pptx')).toBe('pptx');
    expect(officeKind('application/msword', 'a.doc')).toBeNull();
    expect(officeKind('application/octet-stream', 'a.doc')).toBeNull();
    expect(officeKind('application/pdf', 'a.docx')).toBeNull();
    expect(canExtract('application/octet-stream', 'x.odt')).toBe(true);
    expect(canExtract('application/octet-stream', 'x.bin')).toBe(false);
  });
});

describe('docx / pptx / xlsx / odf', () => {
  it('docx: párrafos, tabulaciones, entidades, cabecera y notas; sin etiquetas', () => {
    const buf = docx(
      '<w:p><w:r><w:t>Cláusula de fianza</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Importe:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1.200 &amp; m&#233;s &lt;IVA&gt;</w:t></w:r></w:p>',
      {
        'word/header1.xml': `<w:hdr ${W}><w:p><w:r><w:t>Cabecera canario</w:t></w:r></w:p></w:hdr>`,
        'word/footnotes.xml': `<w:footnotes ${W}><w:p><w:r><w:t>Nota al pie</w:t></w:r></w:p></w:footnotes>`,
      },
    );
    const t = extractOfficeText(buf, 'docx');
    expect(t).toBe(
      'Cláusula de fianza\nImporte:\t1.200 & més <IVA>\n\nNota al pie\n\nCabecera canario',
    );
  });
  it('pptx: diapositivas en orden numérico (2 antes que 10) y notas', () => {
    const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    const slide = (t: string) => `<p:sld><a:p ${A}><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const buf = makeZip({
      'ppt/slides/slide10.xml': slide('diez'),
      'ppt/slides/slide2.xml': slide('dos'),
      'ppt/slides/slide1.xml': slide('uno'),
      'ppt/notesSlides/notesSlide2.xml': slide('nota del dos'),
    });
    expect(extractOfficeText(buf, 'pptx')).toBe(
      'Diapositiva 1\nuno\n\nDiapositiva 2\ndos\nNotas: nota del dos\n\nDiapositiva 3\ndiez',
    );
  });
  it('xlsx: textos compartidos, números, inlineStr y filas separadas por tabulador', () => {
    const buf = makeZip({
      'xl/sharedStrings.xml':
        '<sst><si><t>Concepto</t></si><si><r><t>Alqui</t></r><r><t>ler</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>45.5</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>a &amp; b</t></is></c><c r="C2"/></row></sheetData></worksheet>',
    });
    expect(extractOfficeText(buf, 'xlsx')).toBe('Hoja 1\nConcepto\t45.5\nAlquiler\ta & b');
  });
  it('odt/ods: content.xml', () => {
    const buf = makeZip({
      'content.xml':
        '<office:document-content><text:p>Hola mundo</text:p><text:p>segunda línea</text:p></office:document-content>',
    });
    expect(extractOfficeText(buf, 'odt')).toBe('Hola mundo\nsegunda línea');
  });
  it('las entidades no se expanden: una DTD no inyecta texto', () => {
    const buf = docx('<w:p><w:r><w:t>x&a;y&#0;&#xD800;z&amp;lt;</w:t></w:r></w:p>', {});
    const evil = makeZip({
      'word/document.xml': `<!DOCTYPE d [<!ENTITY a "AAAAAAAA">]><w:document ${W}><w:p><w:r><w:t>x&a;y</w:t></w:r></w:p></w:document>`,
    });
    expect(extractOfficeText(buf, 'docx')).toBe('x&a;yz&lt;');
    const t = extractOfficeText(evil, 'docx');
    expect(t).not.toContain('AAAA');
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
  });
});

describe('límites anti zip-bomb y archivos dañados', () => {
  it('una parte que dice ser pequeña pero se infla enorme se rechaza', () => {
    const bomb = makeZip(
      { 'word/document.xml': Buffer.alloc(50 * 1024 * 1024, 0x41) },
      { declaredSize: { 'word/document.xml': 100 } },
    );
    expect(() => extractOfficeText(bomb, 'docx')).toThrow(/dañada|demasiado grande/);
  });
  it('una parte que declara más de 20 MB se rechaza sin inflarla', () => {
    const big = makeZip(
      { 'word/document.xml': 'x' },
      { declaredSize: { 'word/document.xml': 30 * 1024 * 1024 } },
    );
    expect(() => extractOfficeText(big, 'docx')).toThrow(/demasiado grande/);
  });
  it('la suma de partes tiene tope total', () => {
    const part = Buffer.alloc(15 * 1024 * 1024, 0x20);
    const z = makeZip({
      'word/document.xml': part,
      'word/footnotes.xml': part,
      'word/endnotes.xml': part,
    });
    expect(() => extractOfficeText(z, 'docx')).toThrow(/demasiado grande al descomprimirlo/);
  });
  it('contraseña, zip64, demasiadas partes, basura y cortado', () => {
    expect(() =>
      extractOfficeText(
        makeZip({ 'word/document.xml': 'x' }, { encrypted: ['word/document.xml'] }),
        'docx',
      ),
    ).toThrow(/contraseña/);
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_ENTRIES; i++) many[`f${i}`] = '';
    expect(() => extractOfficeText(makeZip(many), 'docx')).toThrow(/demasiadas partes/);
    expect(() => extractOfficeText(Buffer.from('esto no es un zip, ni de lejos'), 'docx')).toThrow(
      /no es un documento válido/,
    );
    const ok = docx('<w:p><w:r><w:t>hola</w:t></w:r></w:p>');
    expect(() => extractOfficeText(ok.subarray(0, ok.length - 30), 'docx')).toThrow(
      /no es un documento válido/,
    );
    const z64 = Buffer.from(ok);
    z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
    expect(() => extractOfficeText(z64, 'docx')).toThrow(/zip64/);
  });
  it('almacenado sin comprimir también se lee; sin partes de texto: vacío', () => {
    const w = makeZip(
      {
        'word/document.xml': `<w:document ${W}><w:p><w:r><w:t>plano</w:t></w:r></w:p></w:document>`,
      },
      { stored: ['word/document.xml'] },
    );
    expect(extractOfficeText(w, 'docx')).toBe('plano');
    expect(extractOfficeText(makeZip({ 'otra.xml': '<a/>' }), 'docx')).toBe('');
  });
});

describe('integración con la memoria documental', () => {
  const A = 'telegram:main:111#main';
  const B = 'telegram:main:222#main';
  it('un docx reenviado se indexa y se encuentra; otro hilo no lo ve ni lo borra', async () => {
    const { m, dir } = mem();
    const buf = docx('<w:p><w:r><w:t>Clausula canarioalfa de rescision</w:t></w:r></w:p>');
    const r = await m.index(
      A,
      { fileId: 'F1', name: 'contrato.docx', mimeType: OFFICE_MIME.docx },
      buf,
    );
    expect(r).toMatchObject({ title: 'contrato.docx', truncated: false });
    expect(m.search(A, 'canarioalfa')).toHaveLength(1);
    expect(m.search(A, 'canarioalfa')[0]).toMatchObject({
      mimeType: OFFICE_MIME.docx,
      truncated: false,
    });
    expect(m.search(B, 'canarioalfa')).toEqual([]);
    const id = (r as { docId: string }).docId;
    expect(m.remove(B, id)).toBe(false); // otro hilo no puede borrarlo
    expect(m.search(A, 'canarioalfa')).toHaveLength(1);
    expect(existsSync(join(dir, 'txt', `${id}.txt`))).toBe(true);
    expect(m.remove(A, id)).toBe(true);
    expect(m.search(A, 'canarioalfa')).toEqual([]);
    expect(m.list(A)).toEqual([]);
    expect(existsSync(join(dir, 'txt', `${id}.txt`))).toBe(false);
    expect(m.remove(A, id)).toBe(false);
  });
  it('mime genérico + extensión .xlsx; vacío -> null; dañado -> error en español', async () => {
    const { m } = mem();
    const x = makeZip({
      'xl/worksheets/sheet1.xml':
        '<worksheet><row><c t="inlineStr"><is><t>celdacanario</t></is></c></row></worksheet>',
    });
    await m.index(A, { fileId: 'F2', name: 'datos.xlsx', mimeType: 'application/octet-stream' }, x);
    expect(m.search(A, 'celdacanario')).toHaveLength(1);
    expect(
      await m.index(
        A,
        { fileId: 'F3', name: 'v.docx', mimeType: OFFICE_MIME.docx },
        makeZip({ 'a.xml': '<a/>' }),
      ),
    ).toBeNull();
    await expect(
      m.index(
        A,
        { fileId: 'F4', name: 'x.docx', mimeType: OFFICE_MIME.docx },
        Buffer.from('basura'),
      ),
    ).rejects.toThrow(/no es un documento válido/);
  });
  it('borrar cubre fotos (image/ocr) y audios; ids inválidos no borran nada', () => {
    const { m } = mem();
    const foto = m.indexOcr(A, 'foto1', 'DNI canariofoto 12345', 'mi dni') as { docId: string };
    const audio = m.indexTranscript(A, 'm1', 'canarioaudio dicho', undefined) as { docId: string };
    expect(m.remove(A, '../../etc/passwd')).toBe(false);
    expect(m.remove(A, foto.docId)).toBe(true);
    expect(m.search(A, 'canariofoto')).toEqual([]);
    expect(m.search(A, 'canarioaudio')).toHaveLength(1);
    expect(m.remove(A, audio.docId)).toBe(true);
    expect(m.stats(A)).toEqual({ docs: 0, partial: 0 });
  });
});

describe('herramienta documents', () => {
  const A = 'telegram:main:111#main';
  const B = 'telegram:main:222#main';
  it('list muestra [id] y tipo; delete borra solo lo del propio hilo y lo dice', async () => {
    const { m } = mem();
    const foto = m.indexOcr(A, 'foto1', 'fianza canariotool', 'el piso') as { docId: string };
    let scope = A;
    const tool = createDocsTool(m, () => scope);
    const list = textOf(
      await tool.execute('1', { action: 'list' }, undefined as never, undefined as never),
    );
    expect(list).toContain(`[${foto.docId}] foto: el piso (foto, texto leído con OCR`);
    scope = B;
    const no = textOf(
      await tool.execute(
        '2',
        { action: 'delete', docId: foto.docId },
        undefined as never,
        undefined as never,
      ),
    );
    expect(no).toContain('No he encontrado ese elemento');
    expect(m.search(A, 'canariotool')).toHaveLength(1);
    scope = A;
    const yes = textOf(
      await tool.execute(
        '3',
        { action: 'delete', docId: foto.docId },
        undefined as never,
        undefined as never,
      ),
    );
    expect(yes).toContain('lo he olvidado');
    expect(m.search(A, 'canariotool')).toEqual([]);
    await expect(
      tool.execute('4', { action: 'delete' }, undefined as never, undefined as never),
    ).rejects.toThrow(/docId/);
  });
  it('search muestra tipo y parcial; si no hay resultados, dice la cobertura', async () => {
    const { m } = mem();
    const tool = createDocsTool(m, () => A);
    const empty = textOf(
      await tool.execute(
        '1',
        { action: 'search', query: 'nada' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(empty).toContain('este chat no tiene nada guardado todavía');
    const big = Array.from(
      { length: 2500 },
      (_, i) => `linea ${i} ${'palabra '.repeat(40)} canarioparcial`,
    ).join('\n\n');
    m.indexOcr(A, 'f9', big);
    const hit = textOf(
      await tool.execute(
        '2',
        { action: 'search', query: 'canarioparcial' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(hit).toContain('foto, texto leído con OCR');
    const miss = textOf(
      await tool.execute(
        '3',
        { action: 'search', query: 'inexistente' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(miss).toContain('busqué en 1 elemento, 1 indexado solo en parte');
  });
  it('la descripción cubre fotos, Office y el borrado', () => {
    const { m } = mem();
    const d = createDocsTool(m, () => A).description;
    expect(d).toContain('photos');
    expect(d).toContain('Word/Excel/PowerPoint');
    expect(d).toContain('action=delete');
  });
});
