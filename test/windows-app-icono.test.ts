import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BIENVENIDA,
  bmp24,
  COLORES,
  ICON_SIZES,
  icoFromPngs,
  logoSvg,
  makeIcons,
  TRAY_SIZES,
  // @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
} from '../scripts/windows-app/icono.mjs';

const SVG = 'scripts/windows-app/asistenta.svg';
const nsi = readFileSync('scripts/windows-app/asistenta.nsi', 'utf8');
const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');

/** Entradas PNG de un .ico: tamaño y bytes. */
function entradas(ico: Buffer) {
  const out: { size: number; data: Buffer }[] = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const e = 6 + 16 * i;
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    out.push({ size: ico[e] || 256, data: ico.subarray(off, off + len) });
  }
  return out;
}

describe('icono de Asistenta (logo elegido por Nico: «A» con punto azul)', () => {
  it('el logo es un SVG pequeño y coincide con el que dibuja icono.mjs', () => {
    const svg = readFileSync(SVG, 'utf8');
    expect(svg.trim()).toBe(logoSvg(512));
    expect(svg.length).toBeLessThan(2048);
    expect(svg).toContain(`fill="${COLORES.placa}"`);
    expect(svg).toContain(`fill="${COLORES.punto}"`);
    expect(svg).not.toMatch(/<text|<image|href=/);
  });

  it('hasta 32 px usa el dibujo ajustado a 16 px; sin punto para la bandeja', () => {
    expect(logoSvg(16)).toContain('viewBox="0 0 16 16"');
    expect(logoSvg(32)).toContain('viewBox="0 0 16 16"');
    expect(logoSvg(48)).toContain('viewBox="0 0 512 512"');
    expect(logoSvg(16)).toContain(COLORES.punto);
    expect(logoSvg(16, { punto: false })).not.toContain(COLORES.punto);
    expect(logoSvg(16)).toContain('stroke-width="1"');
    expect(logoSvg(32)).toContain('stroke-width="0.5"');
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
    expect(ICON_SIZES).toEqual([16, 20, 24, 32, 48, 64, 128, 256]);
    expect(TRAY_SIZES).toEqual([16, 20, 24, 32]);
  });

  it('BMP de 24 bits de abajo arriba y en BGR (lo que pide NSIS)', () => {
    const bmp = bmp24(1, 2, Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM');
    expect([bmp.readInt32LE(18), bmp.readInt32LE(22), bmp.readUInt16LE(28)]).toEqual([1, 2, 24]);
    expect([...bmp.subarray(54, 57)]).toEqual([6, 5, 4]);
    expect([...bmp.subarray(58, 61)]).toEqual([3, 2, 1]);
  });

  type Sharp = typeof import('sharp').default;
  let sharp: Sharp | null = null;
  try {
    sharp = createRequire(import.meta.url)('sharp');
  } catch {}
  it.skipIf(!sharp)('genera los .ico nítidos y la imagen lateral desde el logo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-icono-'));
    const sh = sharp as Sharp;
    type Rgb = [number, number, number];
    const px = async (png: Buffer) => {
      const { data, info } = await sh(png).raw().toBuffer({ resolveWithObject: true });
      return (x: number, y: number): Rgb => {
        const o = (y * info.width + x) * 4;
        return [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0];
      };
    };
    const azul = ([r, g, b]: Rgb) => b > 200 && r < 140 && g > 100 && g < 180;
    try {
      const { ico, bandeja, bmp } = await makeIcons(dir, sh);
      const app = entradas(readFileSync(ico));
      expect(app.map((e) => e.size)).toEqual(ICON_SIZES);
      for (const e of app) {
        const meta = await sh(e.data).metadata();
        expect([meta.width, meta.height]).toEqual([e.size, e.size]);
      }
      // A 16 px: placa grafito en la esquina, «A» blanca arriba y punto azul que se ve.
      const [a16] = app;
      if (!a16) throw new Error('falta la entrada de 16 px');
      const p16 = await px(a16.data);
      expect(p16(1, 8)).toEqual([17, 24, 39]);
      expect(Math.min(...p16(7, 4))).toBeGreaterThan(150);
      expect(azul(p16(7, 10)) || azul(p16(8, 10))).toBe(true);
      const t = entradas(readFileSync(bandeja));
      expect(t.map((e) => e.size)).toEqual(TRAY_SIZES);
      const [b16] = t;
      if (!b16) throw new Error('falta la entrada de 16 px de la bandeja');
      const t16 = await px(b16.data);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) expect(azul(t16(x, y))).toBe(false);
      const b = readFileSync(bmp);
      expect([b.readInt32LE(18), b.readInt32LE(22)]).toEqual([BIENVENIDA.width, BIENVENIDA.height]);
      expect([...b.subarray(54, 57)]).toEqual([39, 24, 17]);
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
    expect(tray).toContain("Join-Path (Split-Path $app -Parent) 'asistenta.ico'");
  });

  it('la bandeja usa el logo sin punto, con el punto de estado en su esquina y a su tamaño', () => {
    expect(nsi).toContain('File "@@STAGE@@/bandeja.ico"');
    expect(nsi).toContain('Delete "$INSTDIR\\bandeja.ico"');
    expect(tray).toContain("Join-Path (Split-Path $app -Parent) 'bandeja.ico'");
    expect(tray).toMatch(
      /if \(-not \(Test-Path -LiteralPath \$trayIco\)\) \{ \$trayIco = \$appIco \}/,
    );
    expect(tray).toContain('SystemInformation]::SmallIconSize');
    expect(tray).toContain('New-Object System.Drawing.Icon($trayIco, $tam, $tam)');
    // Mismos cuatro estados que antes.
    expect(tray.match(/= New-Punto \(/g)).toHaveLength(4);
  });
});
