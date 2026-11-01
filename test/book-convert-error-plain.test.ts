import { describe, expect, it } from 'vitest';
import { conversionFailText, pdfToEpub } from '../src/books/convert.js';

// robustez-10: si Calibre falla al pasar un PDF a EPUB, la nota que llega al
// chat ya no es su traceback; es una causa en castellano y el libro sale en PDF.
const PDF = Buffer.from('%PDF-1.4 fake');

async function noteFor(stderr: string, code = 1): Promise<string> {
  const r = await pdfToEpub(PDF, 'T', async () => ({ code, stderr }), 'ebook-convert');
  if (r.ok) throw new Error('expected a failure');
  return r.message;
}

describe('conversión de libros: fallos en castellano llano', () => {
  it('traceback de Calibre: frase clara, sin Python ni rutas', async () => {
    const m = await noteFor(
      'Traceback (most recent call last):\n  File "C:\\Program Files\\Calibre2\\app\\bin\\ebook-convert.py"\nValueError: not enough values to unpack',
    );
    expect(m).toContain('lo dejo en PDF');
    expect(m).not.toMatch(/Traceback|Calibre2|ValueError|Program Files/);
  });

  it('PDF con DRM, dañado, sin memoria o tiempo agotado', async () => {
    expect(await noteFor('calibre.ebooks.DRMError: This file is locked with DRM')).toContain(
      '(DRM)',
    );
    expect(await noteFor('PdfReadError: EOF marker not found')).toContain('dañado');
    expect(await noteFor('MemoryError')).toContain('sin memoria');
    expect(await noteFor('\nETIMEDOUT')).toContain('5 minutos');
  });

  it('sin texto de error: tampoco sale «código 2»', async () => {
    const m = await noteFor('', 2);
    expect(m).not.toContain('código');
    expect(m).toContain('lo dejo en PDF');
  });

  it('conversionFailText nunca devuelve el texto crudo', () => {
    expect(conversionFailText('Segmentation fault (core dumped)')).not.toContain('Segmentation');
  });
});
