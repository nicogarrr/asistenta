import { describe, expect, it } from 'vitest';
import { extractOfficeText } from '../src/memory/office.js';

/** Minimal stored (method 0) zip, enough for the reader. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const docx = (body: string) =>
  zip({
    'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
  });
const p = (runs: string) => `<w:p>${runs}</w:p>`;
const r = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

describe('office: solo el texto actual del documento', () => {
  it('el texto borrado con control de cambios no aparece', () => {
    const text = extractOfficeText(
      docx(
        p(
          `${r('El precio es ')}<w:del w:id="1"><w:r><w:delText>900 €</w:delText></w:r></w:del><w:ins w:id="2">${r('1.200 €')}</w:ins>`,
        ),
      ),
      'docx',
    );
    expect(text).toBe('El precio es 1.200 €');
  });

  it('el texto movido sale una sola vez (en su sitio nuevo)', () => {
    const text = extractOfficeText(
      docx(
        p(`<w:moveFrom w:id="3">${r('Cláusula 7')}</w:moveFrom>`) +
          p(r('Intro')) +
          p(`<w:moveTo w:id="4">${r('Cláusula 7')}</w:moveTo>`),
      ),
      'docx',
    );
    expect(text.match(/Cláusula 7/g)).toHaveLength(1);
    expect(text).toContain('Intro');
  });

  it('los códigos de campo (PAGE, HYPERLINK) no se mezclan con el texto', () => {
    const field =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://evil.example/x" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      r('la web') +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const text = extractOfficeText(docx(p(`${r('Mira ')}${field}`)), 'docx');
    expect(text).toBe('Mira la web');
  });

  it('ODF: el registro de cambios no se lee como texto', () => {
    const content =
      '<office:document-content><office:body><office:text><text:tracked-changes><text:changed-region text:id="c1"><text:deletion><text:p>texto viejo borrado</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Texto actual</text:p></office:text></office:body></office:document-content>';
    expect(extractOfficeText(zip({ 'content.xml': content }), 'odt')).toBe('Texto actual');
  });

  it('un documento normal sigue igual (párrafos, tabulador, salto)', () => {
    const text = extractOfficeText(
      docx(p(`${r('a')}<w:tab/>${r('b')}<w:br/>${r('c')}`) + p(r('d'))),
      'docx',
    );
    expect(text).toBe('a\tb\nc\nd');
  });

  it('una etiqueta a saltar sin cierre corta la lectura en vez de colgarse', () => {
    const text = extractOfficeText(
      docx(p(r('antes')) + '<w:delText>sin cierre'.repeat(1000)),
      'docx',
    );
    expect(text).toBe('antes');
  });
});
