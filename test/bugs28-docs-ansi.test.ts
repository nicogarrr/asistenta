import { describe, expect, it } from 'vitest';
import { extractText } from '../src/memory/docs.js';

// bugs28: un .txt o .csv que Nico manda por Telegram desde Windows (ANSI o UTF-16) se
// guardaba en la memoria de documentos con «Facturaci�n» y luego no se encontraba.
describe('memoria de documentos: textos de Windows', () => {
  it('ANSI (Windows-1252)', async () => {
    const ansi = Buffer.from([
      ...Buffer.from('Facturaci'),
      0xf3,
      0x6e,
      0x3b,
      0x31,
      0x30,
      0x20,
      0x80,
    ]);
    await expect(extractText(ansi, 'text/csv')).resolves.toBe('Facturación;10 €');
  });

  it('UTF-16 con BOM', async () => {
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Año nuevo', 'utf16le')]);
    await expect(extractText(u16, 'text/plain')).resolves.toBe('Año nuevo');
  });

  it('UTF-8 sigue igual', async () => {
    await expect(extractText(Buffer.from('hola qué tal', 'utf8'), 'text/plain')).resolves.toBe(
      'hola qué tal',
    );
  });
});
