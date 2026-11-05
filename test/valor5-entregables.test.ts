/**
 * Entregables (hueco #5 del informe de huecos): «hazme una gráfica de mis gastos» → PNG en
 * el chat; «pásamelo en Excel» → .xlsx; «en PDF» → PDF. Antes no había forma: el modelo
 * solo podía escribir una tabla en texto. Todo se genera en el PC, sin red ni dependencias
 * nuevas (PNG y xlsx propios; PDF con pdf-lib, que ya estaba).
 */
import { inflateRawSync, inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { leerNumero, nombreArchivo } from '../src/entregables/datos.js';
import {
  ALTO,
  ANCHO,
  dibujarGrafica,
  escala,
  PALETA,
  textoDibujable,
} from '../src/entregables/grafica.js';
import { crearPdf } from '../src/entregables/pdf.js';
import { crc32 } from '../src/entregables/png.js';
import { crearXlsx, letraColumna, nombreHoja } from '../src/entregables/xlsx.js';
import { extractOfficeText } from '../src/memory/office.js';
import { Gate } from '../src/permissions.js';
import { createEntregableTool, graficaDeTabla } from '../src/tools/entregable.js';

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

/** Descomprime un PNG RGB de 8 bits (filtro 0) y devuelve sus píxeles. */
function leerPng(png: Buffer): { w: number; h: number; px: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('latin1');
    const data = png.subarray(off + 8, off + 8 + len);
    expect(png.readUInt32BE(off + 8 + len)).toBe(crc32(png.subarray(off + 4, off + 8 + len)));
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect(data[9]).toBe(2);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
  return { w, h, px };
}

function cuenta(px: Buffer, c: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 3)
    if (px[i] === c[0] && px[i + 1] === c[1] && px[i + 2] === c[2]) n++;
  return n;
}

/** Ficheros de un zip (cabeceras locales con tamaños, como los escribe crearXlsx). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const comp = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const xlen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString('utf8');
    const data = buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + comp);
    out.set(name, inflateRawSync(data).toString('utf8'));
    off += 30 + nlen + xlen + comp;
  }
  return out;
}

const GASTOS = {
  columnas: ['Categoría', 'Importe'],
  filas: [
    ['Súper', '312,45 €'],
    ['Gasolina', 120],
    ['Luz', '58,10'],
    ['Restaurantes', '1.020,00 €'],
  ],
};

describe('importes como los escribe una persona en España', () => {
  it('lee «1.234,56 €», «12,5», «1.234» y deja fechas y texto como texto', () => {
    expect(leerNumero('1.234,56 €')).toBe(1234.56);
    expect(leerNumero('12,5')).toBe(12.5);
    expect(leerNumero('1.234')).toBe(1234);
    expect(leerNumero('1,234.56')).toBe(1234.56);
    expect(leerNumero('-3 %')).toBe(-3);
    expect(leerNumero('12.50')).toBe(12.5);
    expect(leerNumero(42)).toBe(42);
    expect(leerNumero('06/11/2026')).toBeNull();
    expect(leerNumero('Súper')).toBeNull();
    expect(leerNumero('')).toBeNull();
    expect(leerNumero(null)).toBeNull();
  });

  it('nombre de archivo válido en Windows', () => {
    expect(nombreArchivo('Gastos: octubre/noviembre?', 'xlsx')).toBe(
      'Gastos octubre noviembre.xlsx',
    );
    expect(nombreArchivo('   ', 'pdf')).toBe('datos.pdf');
  });
});

describe('gráfica PNG', () => {
  it('barras: PNG válido de 1000×620 con barras del color de la serie', () => {
    const png = graficaDeTabla(GASTOS, 'Gastos de octubre');
    const { w, h, px } = leerPng(png);
    expect([w, h]).toEqual([ANCHO, ALTO]);
    expect(cuenta(px, PALETA[0] as readonly number[])).toBeGreaterThan(5_000);
    expect(cuenta(px, PALETA[1] as readonly number[])).toBe(0);
  });

  it('dos series de números: dos colores y leyenda', () => {
    const png = graficaDeTabla(
      {
        columnas: ['Mes', '2025', '2026'],
        filas: [
          ['Ene', 10, 12],
          ['Feb', 20, 18],
          ['Mar', 15, 30],
        ],
      },
      'Comparativa',
      'lineas',
    );
    const { px } = leerPng(png);
    expect(cuenta(px, PALETA[0] as readonly number[])).toBeGreaterThan(200);
    expect(cuenta(px, PALETA[1] as readonly number[])).toBeGreaterThan(200);
  });

  it('tarta: un color por categoría', () => {
    const { px } = leerPng(graficaDeTabla(GASTOS, 'Reparto', 'tarta'));
    for (let i = 0; i < 4; i++)
      expect(cuenta(px, PALETA[i] as readonly number[])).toBeGreaterThan(1_000);
  });

  it('sin columnas de números o con demasiados puntos lo dice claro', () => {
    expect(() => graficaDeTabla({ columnas: ['A', 'B'], filas: [['x', 'y']] }, 't')).toThrow(
      /columna de números/,
    );
    const muchas = {
      columnas: ['Día', 'Gasto'],
      filas: Array.from({ length: 90 }, (_, i) => [`d${i}`, i]),
    };
    expect(() => graficaDeTabla(muchas, 't')).toThrow(/Agrúpalas/);
    expect(() =>
      dibujarGrafica({
        titulo: 't',
        etiquetas: ['a'],
        series: [{ nombre: 's', valores: [0] }],
        tipo: 'tarta',
      }),
    ).toThrow(/positivos/);
  });

  it('escala redonda y texto sin tildes para la fuente', () => {
    expect(escala(0, 1020)).toEqual({ desde: 0, hasta: 1250, paso: 250 });
    expect(escala(-30, 70).desde).toBeLessThan(0);
    expect(textoDibujable('¿Gijón? Año 3º 🙂')).toBe('Gijon? Ano 3o ?');
  });
});

describe('Excel .xlsx', () => {
  it('se abre como hoja de cálculo: cabecera, importes como números y fila Total con SUMA', () => {
    const bytes = crearXlsx({ ...GASTOS, hoja: 'Gastos de octubre', totales: true });
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
      'xl/styles.xml',
    ]);
    const hoja = files.get('xl/worksheets/sheet1.xml') ?? '';
    expect(hoja).toContain('<c r="B2" s="2"><v>312.45</v></c>');
    expect(hoja).toContain('<c r="B5" s="2"><v>1020</v></c>');
    expect(hoja).toContain('<f>SUM(B2:B5)</f><v>1510.55</v>');
    expect(hoja).toContain('state="frozen"');
    expect(files.get('xl/workbook.xml')).toContain('name="Gastos de octubre"');
    // El lector de documentos del propio proyecto lo entiende como un xlsx.
    const txt = extractOfficeText(bytes, 'xlsx');
    expect(txt).toContain('Súper');
    expect(txt).toContain('Restaurantes');
    expect(txt).toContain('312.45');
  });

  it('escapa XML, letras de columna y nombres de hoja', () => {
    const files = unzip(crearXlsx({ columnas: ['A&B <x>'], filas: [['"hola"']] }));
    expect(files.get('xl/worksheets/sheet1.xml')).toContain('A&amp;B &lt;x&gt;');
    expect(letraColumna(0)).toBe('A');
    expect(letraColumna(25)).toBe('Z');
    expect(letraColumna(26)).toBe('AA');
    expect(nombreHoja('Gastos [oct]: 2026/11 y algo más largo de 31')).toHaveLength(31);
  });
});

describe('PDF', () => {
  it('título, tabla en varias páginas y gráfica', async () => {
    const filas = Array.from({ length: 120 }, (_, i) => [`Gasto número ${i + 1} (€)`, `${i},50 €`]);
    const png = graficaDeTabla(GASTOS, 'Gastos');
    const bytes = await crearPdf({
      titulo: 'Gastos de octubre ✅',
      columnas: ['Concepto', 'Importe'],
      filas,
      imagen: png,
      totales: true,
      texto: 'Resumen del mes.',
    });
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(doc.getTitle()).toBe('Gastos de octubre ✅');
  });
});

describe('tool entregable', () => {
  const deps = () => {
    const sent: { kind: string; bytes: Buffer; name?: string }[] = [];
    return {
      sent,
      deps: {
        sendPhoto: async (png: Buffer) => {
          sent.push({ kind: 'photo', bytes: png });
          return true;
        },
        sendDocument: async (bytes: Buffer, name: string) => {
          sent.push({ kind: 'doc', bytes, name });
          return true;
        },
      },
    };
  };

  it('«hazme una gráfica de mis gastos» manda una imagen al chat', async () => {
    const { sent, deps: d } = deps();
    const r = await createEntregableTool(d).execute('1', {
      formato: 'grafica',
      titulo: 'Gastos de octubre',
      ...GASTOS,
    });
    expect(textOf(r)).toContain('enviada');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('photo');
    expect(leerPng(sent[0]?.bytes as Buffer).w).toBe(ANCHO);
  });

  it('«pásamelo en Excel» y «en PDF» mandan el archivo con su nombre', async () => {
    const { sent, deps: d } = deps();
    const tool = createEntregableTool(d);
    expect(
      textOf(
        await tool.execute('1', {
          formato: 'excel',
          titulo: 'Gastos de octubre',
          ...GASTOS,
          totales: true,
        }),
      ),
    ).toContain('«Gastos de octubre.xlsx»');
    expect(
      textOf(
        await tool.execute('2', {
          formato: 'pdf',
          titulo: 'Gastos de octubre',
          ...GASTOS,
          con_grafica: true,
        }),
      ),
    ).toContain('«Gastos de octubre.pdf»');
    expect(sent.map((s) => s.name)).toEqual(['Gastos de octubre.xlsx', 'Gastos de octubre.pdf']);
    expect(sent[1]?.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('sin números para la gráfica no manda nada y lo explica', async () => {
    const { sent, deps: d } = deps();
    const r = await createEntregableTool(d).execute('1', {
      formato: 'grafica',
      titulo: 't',
      columnas: ['A'],
      filas: [['x']],
    });
    expect(textOf(r)).toMatch(/columna de números/);
    expect(sent).toHaveLength(0);
  });

  it('si el envío falla lo dice', async () => {
    const r = await createEntregableTool({
      sendPhoto: async () => false,
      sendDocument: async () => false,
    }).execute('1', {
      formato: 'excel',
      titulo: 'x',
      ...GASTOS,
    });
    expect(textOf(r)).toMatch(/No he podido/);
  });

  it('la Gate lo trata como lectura (solo manda a esta conversación)', () => {
    expect(
      new Gate().classifyEffect({ tool: 'entregable', args: { formato: 'pdf' }, actor: 'test' }),
    ).toBe('lee');
  });
});
