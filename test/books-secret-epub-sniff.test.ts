import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sniffsAsEpub } from '../src/books/secret.js';

/** One ZIP local file entry (30-byte header + name + data), enough for a sniffer. */
function entry(name: string, data: Buffer, method: 0 | 8 = 0): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(method, 8);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([head, Buffer.from(name), data]);
}

const CONTAINER = Buffer.from('<?xml version="1.0"?><container><rootfiles/></container>');
const PAGE = Buffer.from(`<html>${'x'.repeat(700)}</html>`);

describe('sniffsAsEpub: EPUB reales que no siguen la spec al pie de la letra', () => {
  it('mimetype comprimido (muchos EPUB de Calibre/zip) sigue siendo un EPUB', () => {
    const epub = Buffer.concat([
      entry('mimetype', deflateRawSync('application/epub+zip'), 8),
      entry('META-INF/container.xml', CONTAINER),
      entry('OEBPS/cap1.xhtml', PAGE),
    ]);
    expect(epub.subarray(0, 512).includes('application/epub+zip')).toBe(false);
    expect(sniffsAsEpub(epub)).toBe(true);
  });

  it('mimetype que no va primero (más allá de 512 bytes) sigue siendo un EPUB', () => {
    const epub = Buffer.concat([
      entry('OEBPS/cap1.xhtml', PAGE),
      entry('META-INF/container.xml', CONTAINER),
      entry('mimetype', Buffer.from('application/epub+zip')),
    ]);
    expect(sniffsAsEpub(epub)).toBe(true);
  });

  it('el EPUB de la spec sigue valiendo', () => {
    const epub = Buffer.concat([
      entry('mimetype', Buffer.from('application/epub+zip')),
      entry('OEBPS/cap1.xhtml', PAGE),
    ]);
    expect(sniffsAsEpub(epub)).toBe(true);
  });

  it('un DOCX o un ZIP de PDFs no es un EPUB', () => {
    const docx = Buffer.concat([
      entry('[Content_Types].xml', Buffer.from('<Types/>'.repeat(10))),
      entry('word/document.xml', PAGE),
    ]);
    const pdfs = Buffer.concat([entry('libro.pdf', Buffer.from(`%PDF-1.4 ${'y'.repeat(600)}`))]);
    expect(sniffsAsEpub(docx)).toBe(false);
    expect(sniffsAsEpub(pdfs)).toBe(false);
  });

  it('más estricto: «PK» sin cabecera de entrada ZIP no basta aunque diga epub', () => {
    const fake = Buffer.from(`PK application/epub+zip META-INF/container.xml ${'z'.repeat(80)}`);
    expect(sniffsAsEpub(fake)).toBe(false);
  });
});
