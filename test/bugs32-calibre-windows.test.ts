import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// bugs-32 (11 nov 2026): en Windows, borrar la carpeta temporal justo después de Calibre
// falla a menudo (EBUSY/EPERM: el antivirus o ebook-convert aún tienen el fichero). Como el
// borrado iba en el `finally`, el error tapaba el resultado: el AZW3 ya convertido se perdía
// y Nico leía «Calibre no pudo convertirlo».

const busy = Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: vi.fn(() => {
      throw busy;
    }),
  };
});

const { cleanTmp, epubToAzw3, pdfToEpub } = await import('../src/books/convert.js');

describe('Calibre en Windows: la carpeta temporal ocupada no tira la conversión', () => {
  it('EPUB → AZW3 sale aunque la carpeta temporal no se pueda borrar', async () => {
    const run = async (_cmd: string, args: string[]) => {
      writeFileSync(args[1] as string, 'AZW3!');
      return { code: 0, stderr: '' };
    };
    const r = await epubToAzw3(Buffer.from('epub'), 'Munger', run, 'ebook-convert');
    expect(r).toEqual({ ok: true, azw3: Buffer.from('AZW3!') });
  });

  it('PDF → EPUB igual', async () => {
    const run = async (_cmd: string, args: string[]) => {
      writeFileSync(args[1] as string, 'EPUB!');
      return { code: 0, stderr: '' };
    };
    const r = await pdfToEpub(Buffer.from('%PDF-'), 'Libro', run, 'ebook-convert');
    expect(r).toEqual({ ok: true, epub: Buffer.from('EPUB!') });
  });

  it('cleanTmp reintenta (maxRetries) y nunca lanza', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugs32-tmp-'));
    const rm = vi.fn(() => {
      throw busy;
    });
    expect(() => cleanTmp(dir, rm as never)).not.toThrow();
    expect(rm).toHaveBeenCalledWith(dir, expect.objectContaining({ maxRetries: 5 }));
    expect(existsSync(dir)).toBe(true);
  });
});
