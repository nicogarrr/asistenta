/**
 * Datos de un entregable («hazme una gráfica de mis gastos», «pásamelo en Excel», «en PDF»).
 *
 * El modelo pasa una tabla: columnas y filas. Los importes llegan como los escribe una
 * persona en España («1.234,56 €», «12,5», «-3 %»), y aquí se leen como números. Una fecha
 * («06/11/2026») o un texto no son números: se quedan como texto.
 */

export type Celda = string | number | null;

export interface Tabla {
  columnas: string[];
  filas: Celda[][];
}

/** Lo que sobra alrededor de un importe: moneda, porcentaje y espacios. */
const ADORNOS = /(?:€|eur(?:os?)?|\$|usd|£|%|\s|\u00a0)/gi;

/**
 * «1.234,56 €» → 1234.56; «12,5» → 12.5; «1,234.56» → 1234.56; «1.234» → 1234.
 * `null` si no es un número (texto, fecha, vacío).
 */
export function leerNumero(v: Celda | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(ADORNOS, '');
  if (s === '' || !/^[-+−]?[\d.,]+$/.test(s)) return null;
  s = s.replace('−', '-');
  const coma = s.lastIndexOf(',');
  const punto = s.lastIndexOf('.');
  if (coma >= 0 && punto >= 0) {
    // El último separador es el decimal; el otro, de miles.
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma >= 0) {
    if ((s.match(/,/g) ?? []).length > 1) {
      if (!/^[-+]?\d{1,3}(,\d{3})+$/.test(s)) return null;
      s = s.replace(/,/g, '');
    } else s = s.replace(',', '.');
  } else if (punto >= 0 && /^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) {
    // «1.234» en España son mil doscientos treinta y cuatro.
    s = s.replace(/\./g, '');
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Texto de una celda tal cual (sin `null`). */
export function textoCelda(v: Celda | undefined): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? String(v) : v;
}

/** Columnas (desde la segunda) en las que casi todo es número: las series de una gráfica. */
export function columnasNumericas(t: Tabla): number[] {
  const out: number[] = [];
  for (let c = 0; c < t.columnas.length; c++) {
    let num = 0;
    let llenas = 0;
    for (const f of t.filas) {
      const v = f[c];
      if (v === null || v === undefined || v === '') continue;
      llenas++;
      if (leerNumero(v) !== null) num++;
    }
    if (llenas > 0 && num / llenas >= 0.8) out.push(c);
  }
  return out;
}

const NF = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });

/** 1234.5 → «1.234,5» (como se lee en España). */
export function numeroES(n: number): string {
  // es-ES no agrupa los números de 4 cifras; para importes se lee mejor con el punto.
  const s = NF.format(n);
  return /^-?\d{4}(,|$)/.test(s) ? s.replace(/^(-?\d)(\d{3})/, '$1.$2') : s;
}

/** Nombre de archivo seguro en Windows: sin \ / : * ? " < > | ni puntos al final. */
export function nombreArchivo(base: string, ext: string): string {
  const limpio = base
    .normalize('NFC')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return `${limpio || 'datos'}.${ext}`;
}
