import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sniff } from '../src/books/net.js';

/** A minimal ZIP local-file record (enough for the sniffer: header + name + data). */
function entry(name: string, data: Buffer, compressed = false): Buffer {
  const body = compressed ? deflateRawSync(data) : data;
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(compressed ? 8 : 0, 8);
  h.writeUInt32LE(body.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, Buffer.from(name, 'latin1'), body]);
}
const zip = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(64)]);
const opf = Buffer.from('<container><rootfiles/></container>'.repeat(4));

describe('books/net sniff: un ZIP cualquiera no es un EPUB', () => {
  it('EPUB según la spec (mimetype primero, sin comprimir) → epub', () => {
    const b = zip(
      entry('mimetype', Buffer.from('application/epub+zip')),
      entry('META-INF/container.xml', opf, true),
    );
    expect(sniff(b)).toBe('epub');
  });

  it('EPUB real con el mimetype comprimido o más tarde → epub (por META-INF/container.xml)', () => {
    const b = zip(
      entry('OEBPS/content.opf', opf, true),
      entry('META-INF/container.xml', opf, true),
      entry('mimetype', Buffer.from('application/epub+zip'), true),
    );
    expect(sniff(b)).toBe('epub');
  });

  it('un .zip de PDFs, un DOCX o un ZIP vacío → no es un libro', () => {
    expect(sniff(zip(entry('libro.pdf', Buffer.from('%PDF-1.7 ...'.repeat(10)))))).toBeNull();
    expect(
      sniff(zip(entry('[Content_Types].xml', opf, true), entry('word/document.xml', opf, true))),
    ).toBeNull();
    expect(sniff(Buffer.concat([Buffer.from('PK\u0005\u0006'), Buffer.alloc(80)]))).toBeNull();
  });

  it('PDF y basura siguen como antes', () => {
    expect(sniff(Buffer.from('%PDF-1.4\n%âãÏÓ'))).toBe('pdf');
    expect(sniff(Buffer.from('<html>no</html>'))).toBeNull();
  });
});
