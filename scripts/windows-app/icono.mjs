// Logo de Asistenta (el que eligió Nico el 1 nov 2026): una «A» geométrica blanca sobre una
// placa grafito redondeada, con un punto azul de cursor. Desde aquí salen el icono del
// instalador, el menú Inicio, «Agregar o quitar programas» y la bandeja: un .ico de 16 a 256 px,
// el de la bandeja (sin el punto azul: ahí el punto es el de estado) y la imagen lateral del
// instalador (BMP 164x314). Se dibuja en SVG y se pinta con sharp, que ya está en node_modules.
// `node scripts/windows-app/icono.mjs` reescribe asistenta.svg (un test exige que coincida).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICON_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
/** Tamaños de la bandeja: 16 px al 100 % de escala, 20 al 125 %, 24 al 150 %, 32 al 200 %. */
export const TRAY_SIZES = [16, 20, 24, 32];
export const COLORES = { placa: '#111827', letra: '#ffffff', punto: '#4f8cff' };
export const BIENVENIDA = { width: 164, height: 314 };
/** Hasta este tamaño se usa el dibujo ajustado a la rejilla de 16 px. */
export const PEQUENO_MAX = 32;

const svg = (vb, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}">${body}</svg>`;

/**
 * El logo dibujado para `size` píxeles. Hasta 32 px va sobre una rejilla de 16: trazo más
 * grueso, «A» más abierta, punto mayor y borde de 1 px, para que a 16 px se lea la «A» y el
 * punto no toque las patas. Desde 48 px, el dibujo original (rejilla de 512).
 * `punto: false` lo deja sin el punto azul (la bandeja pone ahí el de estado).
 */
export function logoSvg(size = 512, { punto = true } = {}) {
  const { placa, letra, punto: azul } = COLORES;
  if (size <= PEQUENO_MAX) {
    const e = 16 / size;
    return svg(
      16,
      `<rect width="16" height="16" rx="3.6" fill="${placa}"/>` +
        `<rect x="${e / 2}" y="${e / 2}" width="${16 - e}" height="${16 - e}" rx="${3.6 - e / 2}" fill="none" stroke="${letra}" stroke-opacity=".14" stroke-width="${e}"/>` +
        `<path d="M3.6 13.2 8 2.8l4.4 10.4" fill="none" stroke="${letra}" stroke-width="2" stroke-linejoin="round"/>` +
        (punto ? `<circle cx="8" cy="10.6" r="1.5" fill="${azul}"/>` : ''),
    );
  }
  return svg(
    512,
    `<rect width="512" height="512" rx="112" fill="${placa}"/>` +
      `<rect x="4" y="4" width="504" height="504" rx="108" fill="none" stroke="${letra}" stroke-opacity=".16" stroke-width="8"/>` +
      `<path d="M150 396 256 120l106 276" fill="none" stroke="${letra}" stroke-width="58" stroke-linejoin="round"/>` +
      (punto ? `<circle cx="256" cy="318" r="30" fill="${azul}"/>` : ''),
  );
}

/** Imagen lateral del instalador: fondo grafito con la «A» y el punto, sin placa. */
export function bienvenidaSvg() {
  const { width: w, height: h } = BIENVENIDA;
  const { placa, letra, punto } = COLORES;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="${placa}"/>` +
    `<path d="M52 150 82 72l30 78" fill="none" stroke="${letra}" stroke-width="16" stroke-linejoin="round"/>` +
    `<circle cx="82" cy="128" r="8.5" fill="${punto}"/>` +
    `<rect x="62" y="186" width="40" height="3" rx="1.5" fill="${punto}"/>` +
    '</svg>'
  );
}

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

/** PNG de `size` px pintado directamente a ese tamaño (nítido, sin reescalar). */
export function pngLogo(size, sharp, opts) {
  const vb = size <= PEQUENO_MAX ? 16 : 512;
  return sharp(Buffer.from(logoSvg(size, opts)), { density: (72 * size) / vb })
    .resize(size, size)
    .png()
    .toBuffer();
}

/** Escribe asistenta.ico, bandeja.ico y bienvenida.bmp en outDir. */
export async function makeIcons(outDir, sharp) {
  const app = [];
  for (const s of ICON_SIZES) app.push({ size: s, data: await pngLogo(s, sharp) });
  const tray = [];
  for (const s of TRAY_SIZES)
    tray.push({ size: s, data: await pngLogo(s, sharp, { punto: false }) });
  const { width, height } = BIENVENIDA;
  const rgb = await sharp(Buffer.from(bienvenidaSvg()))
    .resize(width, height)
    .removeAlpha()
    .raw()
    .toBuffer();
  const ico = join(outDir, 'asistenta.ico');
  const bandeja = join(outDir, 'bandeja.ico');
  const bmp = join(outDir, 'bienvenida.bmp');
  writeFileSync(ico, icoFromPngs(app));
  writeFileSync(bandeja, icoFromPngs(tray));
  writeFileSync(bmp, bmp24(width, height, rgb));
  return { ico, bandeja, bmp };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  writeFileSync(join(dirname(process.argv[1]), 'asistenta.svg'), `${logoSvg(512)}\n`);
