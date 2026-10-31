import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BIENVENIDA,
  bmp24,
  ICON_SIZES,
  icoFromPngs,
  makeIcons,
  // @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
} from '../scripts/windows-app/icono.mjs';

const SRC = 'scripts/windows-app/asistenta.png';
const nsi = readFileSync('scripts/windows-app/asistenta.nsi', 'utf8');

describe('icono de Asistenta (imagen elegida por Nico)', () => {
  it('la imagen de origen es un PNG pequeño de 512x512', () => {
    const png = readFileSync(SRC);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
    expect(png.length).toBeLessThan(200 * 1024);
  });

  it('.ico con una entrada por tamaño (256 se escribe como 0)', () => {
    const data = [Buffer.from('a'), Buffer.from('bcd')];
    const ico = icoFromPngs([
      { size: 16, data: data[0] },
      { size: 256, data: data[1] },
    ]);
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 2]);
    expect([ico[6], ico[22]]).toEqual([16, 0]);
    expect(ico.readUInt32LE(6 + 12)).toBe(38);
    expect(ico.subarray(38).toString()).toBe('abcd');
    expect(ICON_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('BMP de 24 bits de abajo arriba y en BGR (lo que pide NSIS)', () => {
    const bmp = bmp24(1, 2, Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM');
    expect([bmp.readInt32LE(18), bmp.readInt32LE(22), bmp.readUInt16LE(28)]).toEqual([1, 2, 24]);
    expect([...bmp.subarray(54, 57)]).toEqual([6, 5, 4]);
    expect([...bmp.subarray(58, 61)]).toEqual([3, 2, 1]);
  });

  let sharp: unknown = null;
  try {
    sharp = createRequire(import.meta.url)('sharp');
  } catch {}
  it.skipIf(!sharp)('genera el .ico y la imagen lateral desde la imagen de origen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-icono-'));
    try {
      const { ico, bmp } = await makeIcons(SRC, dir, sharp);
      const i = readFileSync(ico);
      expect(i.readUInt16LE(4)).toBe(ICON_SIZES.length);
      const b = readFileSync(bmp);
      expect([b.readInt32LE(18), b.readInt32LE(22)]).toEqual([BIENVENIDA.width, BIENVENIDA.height]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('instalador, accesos, «Agregar o quitar programas» y bandeja usan el icono', () => {
    expect(nsi).toContain('!define MUI_ICON "@@STAGE@@/asistenta.ico"');
    expect(nsi).toContain('!define MUI_WELCOMEFINISHPAGE_BITMAP "@@STAGE@@/bienvenida.bmp"');
    expect(nsi).toContain('"DisplayIcon" "$INSTDIR\\asistenta.ico"');
    for (const l of nsi.split('\n').filter((x) => /CreateShortcut .*(wscript|configurar)/.test(x)))
      expect(l.trimEnd()).toMatch(/ "\$INSTDIR\\asistenta\.ico"$/);
    const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');
    expect(tray).toContain("Join-Path (Split-Path $app -Parent) 'asistenta.ico'");
  });
});
