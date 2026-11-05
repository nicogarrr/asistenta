import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeTextFile, readTool } from '../src/tools/fs.js';

// bugs28: «read» leía todo como UTF-8. Un CSV de Excel o un .txt del Bloc de notas en ANSI
// (Windows-1252) llegaba con «Facturaci�n», y lo que deja `dir > lista.txt` en PowerShell 5
// (UTF-16 con BOM) llegaba como letras separadas por NUL: el asistente no podía leerlo.
const cwd = process.cwd();
let work = '';
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'b28-read-'));
  process.chdir(work);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
});

const text = async (path: string): Promise<string> => {
  const r = await readTool.execute('id', { path } as never);
  return (r.content[0] as { text: string }).text;
};

describe('read: ficheros de Windows que no son UTF-8', () => {
  it('ANSI (Windows-1252): tildes, eñes y €', async () => {
    writeFileSync(
      'banco.csv',
      Buffer.from([
        ...Buffer.from('Concepto;Importe\r\nFacturaci'),
        0xf3,
        0x6e,
        0x20,
        0x45,
        0x73,
        0x70,
        0x61,
        0xf1,
        0x61,
        0x3b,
        0x31,
        0x30,
        0x20,
        0x80,
      ]),
    );
    const out = await text('banco.csv');
    expect(out).toContain('Facturación España;10 €');
    expect(out).toContain('Windows-1252');
    expect(out).not.toContain('\uFFFD');
  });

  it('UTF-16 con BOM (PowerShell 5 «> fichero.txt»)', async () => {
    const body = Buffer.from('Nombre\r\nFacturación\r\n', 'utf16le');
    writeFileSync('lista.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    const out = await text('lista.txt');
    expect(out).toContain('Nombre\nFacturación');
    expect(out).not.toContain('\u0000');
  });

  it('UTF-8 con BOM y fin de línea de Windows: sin BOM ni \\r', async () => {
    writeFileSync('notas.txt', Buffer.from('\uFEFFhola\r\nadiós\r\n', 'utf8'));
    const out = await text('notas.txt');
    expect(out).toContain('\nhola\nadiós');
    expect(out).not.toContain('\uFEFF');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('Windows-1252');
  });

  it('UTF-8 normal no cambia', () => {
    expect(decodeTextFile(Buffer.from('Facturación ñ €', 'utf8'))).toEqual({
      text: 'Facturación ñ €',
      encoding: 'UTF-8',
    });
  });
});
