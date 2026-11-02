import { describe, expect, it } from 'vitest';
import { safeFilename as kindleFilename } from '../src/books/kindle.js';
import { audioFilename, filenameFrom, safeFilename } from '../src/media/download.js';
import { safeRoutineDirName } from '../src/routine-delivery.js';

// Windows no deja crear «con», «nul», «aux», «com1»… ni guarda bien un nombre que acaba en punto o espacio.
describe('nombres de fichero válidos en Windows', () => {
  it('una rutina con nombre reservado de Windows tiene carpeta usable', () => {
    for (const n of ['con', 'Con', 'NUL', 'aux', 'prn', 'com1', 'LPT9']) {
      const dir = safeRoutineDirName(n);
      expect(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(dir)).toBe(false);
      expect(dir.toLowerCase().startsWith(n.toLowerCase())).toBe(true);
    }
    expect(safeRoutineDirName('Consejos')).toBe('Consejos');
    expect(safeRoutineDirName('com10')).toBe('com10');
  });

  it('PDFs y audios no acaban en punto o espacio antes de la extensión', () => {
    expect(safeFilename('Informe final. ')).toBe('Informe final');
    expect(safeFilename('Notas...')).toBe('Notas');
    expect(audioFilename('Canción.')).toBe('Canción.mp3');
    expect(filenameFrom('attachment; filename="factura."', new URL('https://x.test/a'))).toBe(
      'factura.pdf',
    );
    expect(safeFilename(`${'a'.repeat(10)} .${'b'.repeat(20)}`, 11)).toBe('a'.repeat(10));
  });

  it('Kindle: sin espacio antes de «.epub» ni fichero oculto', () => {
    const t = `${'x'.repeat(79)} final`;
    expect(kindleFilename(t, 'epub')).toBe(`${'x'.repeat(79)}.epub`);
    expect(kindleFilename('.Libro oculto', 'epub')).toBe('Libro oculto.epub');
    expect(kindleFilename('Fin.', 'pdf')).toBe('Fin.pdf');
    expect(kindleFilename('...', 'epub')).toBe('libro.epub');
  });
});
