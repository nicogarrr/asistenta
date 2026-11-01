import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pngColourShare } from '../evolve/probe-png.js';

// La sonda comprueba que la captura es de verdad una imagen de su página (pintada con un
// color al azar en cada ejecución) y no unos bytes cualesquiera que devuelve el intento.
function png(w: number, h: number, px: (x: number) => number[], filter = 0): string {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(filter);
    const line: number[] = [];
    for (let x = 0; x < w; x++) line.push(...px(x));
    // filtro 1 (Sub): cada byte menos el del píxel anterior
    for (let i = 0; i < line.length; i++) {
      const v = line[i] ?? 0;
      rows.push(filter === 1 ? (v - (i >= 3 ? (line[i - 3] ?? 0) : 0)) & 0xff : v);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

describe('la captura de la sonda es del color de su página', () => {
  it('cuenta los píxeles del color, también con filtro', () => {
    const half = (x: number) => (x < 5 ? [120, 60, 200] : [255, 255, 255]);
    expect(pngColourShare(png(10, 4, half), [120, 60, 200])).toBeCloseTo(0.5);
    expect(pngColourShare(png(10, 4, half, 1), [122, 58, 200])).toBeCloseTo(0.5);
    expect(pngColourShare(png(10, 4, half), [10, 10, 10])).toBe(0);
  });

  it('unos bytes que no son PNG no valen', () => {
    expect(pngColourShare('x'.repeat(5000), [1, 2, 3])).toBeNull();
    expect(pngColourShare(Buffer.from('hola').toString('base64'), [1, 2, 3])).toBeNull();
  });
});
