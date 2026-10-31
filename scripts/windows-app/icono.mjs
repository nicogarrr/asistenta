// Icono de Asistenta (la imagen que eligió Nico) para el instalador, el menú Inicio,
// «Agregar o quitar programas» y la bandeja. Se genera al construir desde asistenta.png
// (512x512): un .ico de 16 a 256 px recortado a la cara (se reconoce a 16 px) y la imagen
// lateral del asistente (BMP 164x314). Usa sharp, que ya está en node_modules.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Recorte de la cara, relativo al lado de la imagen. */
export const CARA = { left: 0.26, top: 0, size: 0.48 };
export const BIENVENIDA = { width: 164, height: 314 };

/** .ico con una entrada PNG por tamaño (Windows Vista en adelante). */
export function icoFromPngs(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/** BMP de 24 bits (lo que pide NSIS) a partir de píxeles RGB de arriba abajo. */
export function bmp24(width, height, rgb) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    const dst = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      out[dst + x * 3] = rgb[s + 2];
      out[dst + x * 3 + 1] = rgb[s + 1];
      out[dst + x * 3 + 2] = rgb[s];
    }
  }
  return out;
}

/** Escribe asistenta.ico y bienvenida.bmp en outDir. */
export async function makeIcons(src, outDir, sharp) {
  const meta = await sharp(src).metadata();
  const side = Math.min(meta.width, meta.height);
  const size = Math.round(side * CARA.size);
  const cara = {
    left: Math.round(side * CARA.left),
    top: Math.round(side * CARA.top),
    width: size,
    height: size,
  };
  const pngs = [];
  for (const s of ICON_SIZES)
    pngs.push({ size: s, data: await sharp(src).extract(cara).resize(s, s).png().toBuffer() });
  const { width, height } = BIENVENIDA;
  const rgb = await sharp(src)
    .resize(width, height, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer();
  const ico = join(outDir, 'asistenta.ico');
  const bmp = join(outDir, 'bienvenida.bmp');
  writeFileSync(ico, icoFromPngs(pngs));
  writeFileSync(bmp, bmp24(width, height, rgb));
  return { ico, bmp };
}
