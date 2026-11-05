import { numeroES } from './datos.js';
import { encodePng } from './png.js';

/**
 * «Hazme una gráfica de mis gastos»: barras, líneas o tarta en PNG, dibujadas aquí mismo
 * (sin navegador, sin red y sin librerías nativas que compilar en Windows).
 *
 * Letra: la fuente clásica de 5×7 de Adafruit-GFX (glcdfont.c, licencia BSD,
 * © 2012 Adafruit Industries), caracteres ASCII 32-126, más un «€» propio. Las tildes y
 * la eñe se dibujan sin tilde («Gijón» → «Gijon»): se lee igual y no hace falta otra fuente.
 */

const FONT_HEX =
  '000000000000005f00000007000700147f147f14242a7f2a12231308646236495620500008070300001c2241000041221c002a1c7f1c2a08083e080800807030000808080808000060600020100804023e5149453e00427f400072494949462141494d331814127f1027454545393c4a49493141211109073649494936464949291e0000140000004034000000081422411414141414004122140802015909063e415d594e7c1211127c7f494949363e414141227f4141413e7f494949417f090909013e414151737f0808087f00417f41002040413f017f081422417f404040407f021c027f7f0408107f3e4141413e7f090909063e4151215e7f09192946264949493203017f01033f4040403f1f2040201f3f4038403f631408146303047804036159494d43007f4141410204081020004141417f04020102044040404040000307080020545478407f284444383844444428384444287f385454541800087e090218a4a49c787f0804047800447d40002040403d007f1028440000417f40007c047804787c080404783844444438fc1824241818242418fc7c08040408485454542404043f44243c4040207c1c2040201c3c4030403c44281028444c9090907c4464544c440008364100000077000000413608000201020402';

/** «€», en columnas de 7 bits (bit 0 arriba), como las de la fuente. */
const EURO = [0x14, 0x3e, 0x55, 0x55, 0x41];

const glyph = (ch: string): number[] => {
  if (ch === '€') return EURO;
  const code = ch.charCodeAt(0);
  const i = code >= 32 && code <= 126 ? code - 32 : 31; // «?»
  const out: number[] = [];
  for (let k = 0; k < 5; k++)
    out.push(Number.parseInt(FONT_HEX.slice((i * 5 + k) * 2, (i * 5 + k) * 2 + 2), 16));
  return out;
};

/** Quita tildes (á → a, ñ → n) y deja solo lo que la fuente sabe dibujar. */
export function textoDibujable(s: string): string {
  return s
    .replace(/[ñÑ]/g, (m) => (m === 'ñ' ? 'n' : 'N'))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿¡]/g, '')
    .replace(/[ºª]/g, 'o')
    .replace(/[^\u0020-\u007e€]/gu, '?');
}

type RGB = readonly [number, number, number];

const BLANCO: RGB = [255, 255, 255];
const NEGRO: RGB = [33, 37, 41];
const GRIS: RGB = [134, 142, 150];
const REJILLA: RGB = [228, 231, 235];
export const PALETA: readonly RGB[] = [
  [52, 120, 246],
  [240, 101, 72],
  [46, 184, 114],
  [250, 176, 5],
  [132, 94, 247],
  [21, 170, 191],
  [230, 73, 128],
  [130, 201, 30],
  [253, 126, 20],
  [92, 124, 250],
];

class Lienzo {
  readonly px: Uint8Array;
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3).fill(255);
  }
  punto(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (Math.floor(y) * this.w + Math.floor(x)) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.punto(xx, yy, c);
  }
  linea(x0: number, y0: number, x1: number, y1: number, c: RGB, grosor = 1): void {
    const pasos = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const r = Math.floor(grosor / 2);
    for (let i = 0; i <= pasos; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / pasos);
      const y = Math.round(y0 + ((y1 - y0) * i) / pasos);
      this.rect(x - r, y - r, grosor, grosor, c);
    }
  }
  circulo(cx: number, cy: number, radio: number, c: RGB): void {
    for (let y = -radio; y <= radio; y++)
      for (let x = -radio; x <= radio; x++)
        if (x * x + y * y <= radio * radio) this.punto(cx + x, cy + y, c);
  }
  /** Ancho en píxeles de `s` a escala `e` (celda de 6×8 por carácter). */
  static ancho(s: string, e: number): number {
    return textoDibujable(s).length * 6 * e - e;
  }
  texto(x: number, y: number, s: string, c: RGB, e = 2): void {
    let cx = Math.round(x);
    for (const ch of textoDibujable(s)) {
      const g = glyph(ch);
      for (let col = 0; col < 5; col++) {
        const bits = g[col] ?? 0;
        for (let fila = 0; fila < 7; fila++)
          if ((bits >> fila) & 1) this.rect(cx + col * e, y + fila * e, e, e, c);
      }
      cx += 6 * e;
    }
  }
  png(): Buffer {
    return encodePng(this.w, this.h, this.px);
  }
}

export type TipoGrafica = 'barras' | 'lineas' | 'tarta';

export interface Serie {
  nombre: string;
  valores: number[];
}

export interface Grafica {
  titulo: string;
  etiquetas: string[];
  series: Serie[];
  tipo?: TipoGrafica;
}

export const ANCHO = 1000;
export const ALTO = 620;
export const MAX_PUNTOS = 60;
export const MAX_SERIES = PALETA.length;

/** Recorta un texto para que quepa en `px` a escala `e`, con «…» como «..». */
function cabe(s: string, px: number, e: number): string {
  const t = textoDibujable(s);
  const max = Math.max(1, Math.floor((px + e) / (6 * e)));
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 2))}..`;
}

/** Escala «redonda» del eje: 0, 50, 100… o 0, 2,5, 5… */
export function escala(
  min: number,
  max: number,
  marcas = 5,
): { desde: number; hasta: number; paso: number } {
  const lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (hi === lo) hi = lo + 1;
  const bruto = (hi - lo) / marcas;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const n = bruto / mag;
  const paso = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { desde: Math.floor(lo / paso) * paso, hasta: Math.ceil(hi / paso) * paso, paso };
}

function leyenda(l: Lienzo, series: Serie[], y: number): void {
  if (series.length < 2) return;
  let x = 90;
  series.forEach((s, i) => {
    const nombre = cabe(s.nombre, 220, 2);
    l.rect(x, y + 1, 14, 14, PALETA[i % PALETA.length] as RGB);
    l.texto(x + 20, y + 1, nombre, NEGRO, 2);
    x += 20 + Lienzo.ancho(nombre, 2) + 30;
  });
}

function ejes(g: Grafica, l: Lienzo): void {
  const todos = g.series.flatMap((s) => s.valores);
  const { desde, hasta, paso } = escala(Math.min(...todos), Math.max(...todos));
  const izq = 100;
  const der = ANCHO - 30;
  const arriba = g.series.length > 1 ? 100 : 80;
  const abajo = ALTO - 70;
  const yDe = (v: number): number => abajo - ((v - desde) / (hasta - desde)) * (abajo - arriba);
  for (let v = desde; v <= hasta + paso / 2; v += paso) {
    const y = Math.round(yDe(v));
    l.linea(izq, y, der, y, Math.abs(v) < paso / 1e6 ? GRIS : REJILLA);
    const txt = numeroES(Math.round(v * 100) / 100);
    l.texto(izq - 10 - Lienzo.ancho(txt, 2), y - 7, txt, GRIS, 2);
  }
  const n = g.etiquetas.length;
  const hueco = (der - izq) / n;
  // Si las etiquetas no caben todas, se escribe una de cada `cada`.
  const cada = Math.max(1, Math.ceil((7 * 12) / hueco));
  for (let i = 0; i < n; i += cada) {
    const t = cabe(g.etiquetas[i] ?? '', hueco * cada - 6, 2);
    const cx = izq + hueco * (i + 0.5);
    l.texto(cx - Lienzo.ancho(t, 2) / 2, abajo + 14, t, NEGRO, 2);
  }
  if (g.tipo === 'lineas') {
    g.series.forEach((s, si) => {
      const c = PALETA[si % PALETA.length] as RGB;
      let prev: [number, number] | null = null;
      s.valores.forEach((v, i) => {
        const p: [number, number] = [izq + hueco * (i + 0.5), yDe(v)];
        if (prev) l.linea(prev[0], prev[1], p[0], p[1], c, 3);
        prev = p;
      });
      for (const [i, v] of s.valores.entries()) l.circulo(izq + hueco * (i + 0.5), yDe(v), 5, c);
    });
    return;
  }
  const k = g.series.length;
  const anchoGrupo = hueco * 0.75;
  const anchoBarra = anchoGrupo / k;
  const cero = yDe(Math.max(desde, Math.min(0, hasta)));
  g.series.forEach((s, si) => {
    const c = PALETA[si % PALETA.length] as RGB;
    s.valores.forEach((v, i) => {
      const x = izq + hueco * i + (hueco - anchoGrupo) / 2 + si * anchoBarra;
      const y = yDe(v);
      l.rect(x, Math.min(y, cero), Math.max(1, anchoBarra - 2), Math.max(1, Math.abs(cero - y)), c);
      if (k === 1) {
        const txt = numeroES(Math.round(v * 100) / 100);
        if (Lienzo.ancho(txt, 2) <= hueco - 4)
          l.texto(
            x + (anchoBarra - 2) / 2 - Lienzo.ancho(txt, 2) / 2,
            v >= 0 ? y - 20 : y + 6,
            txt,
            NEGRO,
            2,
          );
      }
    });
  });
}

function tarta(g: Grafica, l: Lienzo): void {
  const s = g.series[0] as Serie;
  const partes = s.valores
    .map((v, i) => ({ v: Math.max(0, v), et: g.etiquetas[i] ?? '' }))
    .filter((p) => p.v > 0);
  const total = partes.reduce((a, p) => a + p.v, 0);
  const cx = 300;
  const cy = 340;
  const r = 230;
  const cortes: number[] = [];
  let acc = 0;
  for (const p of partes) {
    acc += p.v / total;
    cortes.push(acc);
  }
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      // Desde las 12 en punto, en el sentido de las agujas del reloj.
      let a = Math.atan2(x, -y) / (2 * Math.PI);
      if (a < 0) a += 1;
      let i = cortes.findIndex((c) => a <= c);
      if (i < 0) i = partes.length - 1;
      l.punto(cx + x, cy + y, PALETA[i % PALETA.length] as RGB);
    }
  }
  let y = 120;
  partes.slice(0, 18).forEach((p, i) => {
    l.rect(580, y + 1, 16, 16, PALETA[i % PALETA.length] as RGB);
    const pct = Math.round((p.v / total) * 1000) / 10;
    l.texto(
      604,
      y + 2,
      cabe(`${p.et}: ${numeroES(p.v)} (${numeroES(pct)}%)`, ANCHO - 620, 2),
      NEGRO,
      2,
    );
    y += 26;
  });
  if (partes.length > 18) l.texto(604, y + 2, `y ${partes.length - 18} mas`, GRIS, 2);
}

/** Dibuja la gráfica y devuelve el PNG. Lanza un Error con un texto para el usuario si no hay datos. */
export function dibujarGrafica(g: Grafica): Buffer {
  const tipo = g.tipo ?? 'barras';
  const n = g.etiquetas.length;
  if (n === 0 || g.series.length === 0) throw new Error('No hay datos para la gráfica.');
  if (n > MAX_PUNTOS)
    throw new Error(
      `Son demasiados puntos para una gráfica (${n}; máximo ${MAX_PUNTOS}). Agrúpalos (por mes, por categoría).`,
    );
  const series = g.series
    .slice(0, MAX_SERIES)
    .map((s) => ({ nombre: s.nombre, valores: g.etiquetas.map((_, i) => s.valores[i] ?? 0) }));
  if (tipo === 'tarta' && !series[0]?.valores.some((v) => v > 0))
    throw new Error('Para una tarta hacen falta valores positivos.');
  const l = new Lienzo(ANCHO, ALTO);
  l.rect(0, 0, ANCHO, ALTO, BLANCO);
  const titulo = cabe(g.titulo, ANCHO - 60, 3);
  l.texto((ANCHO - Lienzo.ancho(titulo, 3)) / 2, 22, titulo, NEGRO, 3);
  const gg = { ...g, tipo, series };
  if (tipo === 'tarta') tarta(gg, l);
  else {
    leyenda(l, series, 62);
    ejes(gg, l);
  }
  return l.png();
}
