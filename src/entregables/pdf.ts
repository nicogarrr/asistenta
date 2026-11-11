import type { PDFFont, PDFPage } from 'pdf-lib';
import { leerNumero, numeroES, type Tabla, textoCelda } from './datos.js';

/**
 * «Pásamelo en PDF»: título, un texto opcional, la tabla (con cabecera que se repite en
 * cada página y los importes alineados a la derecha) y, si se pide, la gráfica. Con
 * pdf-lib (ya está en el proyecto, puro JavaScript): funciona sin red y en Windows.
 */

export interface PdfInput extends Partial<Tabla> {
  titulo: string;
  texto?: string;
  /** PNG para poner debajo del título (la gráfica). */
  imagen?: Buffer;
  totales?: boolean;
}

const A4: [number, number] = [595.28, 841.89];
const MARGEN = 48;

/** Deja solo lo que la fuente estándar (WinAnsi) sabe escribir: tildes, ñ y € sí; emojis no. */
function limpiador(font: PDFFont): (s: string) => string {
  const cache = new Map<string, boolean>();
  return (s) => {
    let out = '';
    for (const ch of s.replace(/\t/g, '    ')) {
      let ok = cache.get(ch);
      if (ok === undefined) {
        try {
          font.encodeText(ch);
          ok = true;
        } catch {
          ok = false;
        }
        cache.set(ch, ok);
      }
      out += ok ? ch : '';
    }
    return out;
  };
}

/** Parte un texto en líneas que caben en `ancho`. */
function partir(s: string, font: PDFFont, size: number, ancho: number): string[] {
  const out: string[] = [];
  for (const parrafo of s.split(/\r?\n/)) {
    let linea = '';
    for (const palabra of parrafo.split(/ +/)) {
      const prueba = linea ? `${linea} ${palabra}` : palabra;
      if (font.widthOfTextAtSize(prueba, size) <= ancho || !linea) linea = prueba;
      else {
        out.push(linea);
        linea = palabra;
      }
    }
    out.push(linea);
  }
  return out;
}

/** Recorta con «…» para que quepa en `ancho`. */
function recortar(s: string, font: PDFFont, size: number, ancho: number): string {
  if (font.widthOfTextAtSize(s, size) <= ancho) return s;
  let t = s;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > ancho) t = t.slice(0, -1);
  return `${t}…`;
}

export async function crearPdf(input: PdfInput): Promise<Buffer> {
  // pdf-lib tarda en cargarse: solo se carga al pedir un PDF, no al arrancar.
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(input.titulo);
  doc.setProducer('Asistenta');
  doc.setCreator('Asistenta');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold);
  const limpio = limpiador(font);
  const ancho = A4[0] - 2 * MARGEN;
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGEN;
  const nueva = (): void => {
    page = doc.addPage(A4);
    y = A4[1] - MARGEN;
  };
  for (const l of partir(limpio(input.titulo), negrita, 18, ancho)) {
    page.drawText(l, { x: MARGEN, y: y - 18, size: 18, font: negrita });
    y -= 24;
  }
  y -= 6;
  if (input.texto?.trim()) {
    // Línea a línea: el salto de línea no está en WinAnsi y `limpio` se lo comía, así que
    // un texto de varios párrafos salía en un solo bloque.
    const texto = input.texto.trim().split(/\r?\n/).map(limpio).join('\n');
    for (const l of partir(texto, font, 11, ancho)) {
      if (y < MARGEN + 14) nueva();
      page.drawText(l, { x: MARGEN, y: y - 11, size: 11, font });
      y -= 15;
    }
    y -= 8;
  }
  if (input.imagen) {
    const img = await doc.embedPng(input.imagen);
    const escala = Math.min(1, ancho / img.width);
    const w = img.width * escala;
    const h = img.height * escala;
    if (y - h < MARGEN) nueva();
    page.drawImage(img, { x: MARGEN, y: y - h, width: w, height: h });
    y -= h + 14;
  }
  const columnas = input.columnas ?? [];
  const filas = input.filas ?? [];
  if (columnas.length > 0) {
    const n = Math.max(columnas.length, ...filas.map((f) => f.length));
    const esNum = Array.from({ length: n }, (_, c) => {
      const llenas = filas.filter((f) => f[c] !== null && f[c] !== undefined && f[c] !== '');
      return (
        llenas.length > 0 &&
        llenas.filter((f) => leerNumero(f[c] ?? null) !== null).length / llenas.length >= 0.8
      );
    });
    const celda = (f: (typeof filas)[number], c: number): string => {
      const v = f[c];
      const x = esNum[c] ? leerNumero(v ?? null) : null;
      return x !== null ? numeroES(x) : limpio(textoCelda(v));
    };
    const cuerpo = filas.map((f) => Array.from({ length: n }, (_, c) => celda(f, c)));
    if (input.totales && filas.length > 0 && esNum.some(Boolean)) {
      const tot = Array.from({ length: n }, (_, c) =>
        esNum[c]
          ? numeroES(
              Math.round(filas.reduce((a, f) => a + (leerNumero(f[c] ?? null) ?? 0), 0) * 100) /
                100,
            )
          : '',
      );
      const primera = esNum.indexOf(false);
      if (primera >= 0) tot[primera] = 'Total';
      cuerpo.push(tot);
    }
    const size = n > 6 ? 8 : 10;
    const cab = Array.from({ length: n }, (_, c) => limpio(columnas[c] ?? ''));
    // Ancho de cada columna según su texto más largo (con tope), repartido en el ancho útil.
    const pesos = cab.map((h, c) =>
      Math.min(
        220,
        Math.max(
          negrita.widthOfTextAtSize(h, size),
          ...cuerpo.slice(0, 500).map((f) => font.widthOfTextAtSize(f[c] ?? '', size)),
        ) + 10,
      ),
    );
    const suma = pesos.reduce((a, b) => a + b, 0) || 1;
    const anchos = pesos.map((p) => (p / suma) * ancho);
    const alto = size + 8;
    const fila = (vals: string[], f: PDFFont, fondo?: [number, number, number]): void => {
      if (y - alto < MARGEN) {
        nueva();
        fila(cab, negrita, [0.9, 0.92, 0.95]);
      }
      if (fondo)
        page.drawRectangle({
          x: MARGEN,
          y: y - alto,
          width: ancho,
          height: alto,
          color: rgb(...fondo),
        });
      let x = MARGEN;
      vals.forEach((v, c) => {
        const w = anchos[c] ?? 0;
        const t = recortar(v, f, size, w - 8);
        const tw = f.widthOfTextAtSize(t, size);
        page.drawText(t, { x: esNum[c] ? x + w - 4 - tw : x + 4, y: y - alto + 5, size, font: f });
        x += w;
      });
      y -= alto;
    };
    fila(cab, negrita, [0.9, 0.92, 0.95]);
    cuerpo.forEach((vals, i) => {
      const esTotal = input.totales && i === cuerpo.length - 1 && cuerpo.length > filas.length;
      fila(vals, esTotal ? negrita : font, i % 2 === 1 ? [0.97, 0.97, 0.97] : undefined);
    });
  }
  return Buffer.from(await doc.save());
}
