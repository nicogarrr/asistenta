import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNumber, verifyTables } from '../src/pdfmd/tables.js';
import { checkPages, splitPages, tableNote, verifyWithRetry } from '../src/pdfmd/verify.js';
import { createOcrLocalTool } from '../src/plugins/ocr.js';

// Ideas de pdf2md (https://github.com/Ntizar/pdf2md, MIT): comprobar tablas sin IA.

const t = (...rows: string[]) => rows.join('\n');

const GOOD_SUM = t(
  '| Gasto | Euros |',
  '|---|---:|',
  '| Luz | 45,50 |',
  '| Agua | 20,00 |',
  '| Gas | 34,50 |',
  '| Total | 100,00 |',
);
const BAD_SUM = t(
  '| Gasto | Euros |',
  '|---|---|',
  '| Luz | 45,50 |',
  '| Agua | 20,00 |',
  '| Gas | 34,50 |',
  '| Total | 108,00 |',
);
const TIME_SERIES = t(
  '| Año | Renovables (GW) |',
  '|---|---|',
  '| 2030 | 160 |',
  '| 2040 | 230 |',
  '| 2050 | 310 |',
);

describe('parseNumber', () => {
  it('entiende formato español, inglés, miles, % y €', () => {
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('1.234')).toBe(1234);
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('2.5')).toBe(2.5);
    expect(parseNumber('12 %')).toBe(12);
    expect(parseNumber('30 €')).toBe(30);
    expect(parseNumber('-7')).toBe(-7);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('2030-2040')).toBeNull();
  });
});

describe('verifyTables: sumas', () => {
  it('una suma buena cuadra', () => {
    const r = verifyTables(GOOD_SUM);
    expect(r).toMatchObject({ ok: true, tables: 1, issues: [] });
  });
  it('tolera redondeos del 1 %', () => {
    expect(verifyTables(GOOD_SUM.replace('100,00', '100,90')).ok).toBe(true);
  });
  it('una suma mala con «Total» declarado falla y lo dice en castellano', () => {
    const r = verifyTables(BAD_SUM);
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.problem).toBe('en la columna «Euros» la suma (100) no da el total (108)');
  });
  it('sin fila Total, un último valor algo mayor que la suma también falla', () => {
    const md = t('| a | b |', '|---|---|', '| x | 20 |', '| y | 10 |', '| z | 35 |');
    expect(verifyTables(md).ok).toBe(false);
  });
  it('sin fila Total, una lista cualquiera de números no se trata como suma', () => {
    const md = t('| a | b |', '|---|---|', '| x | 20 |', '| y | 90 |', '| z | 35 |');
    expect(verifyTables(md).ok).toBe(true);
  });
  it('una serie temporal (2030, 2040, 2050) no es una suma', () => {
    expect(verifyTables(TIME_SERIES).ok).toBe(true);
  });
  it('una serie que baja tampoco es una suma', () => {
    const md = t(
      '| Año | Emisiones |',
      '|---|---|',
      '| 2030 | 300 |',
      '| 2040 | 200 |',
      '| 2050 | 90 |',
    );
    expect(verifyTables(md).ok).toBe(true);
  });
  it('pero si la serie acaba en un «Total» declarado que no cuadra, falla', () => {
    const md = t('| Año | GW |', '|---|---|', '| 2030 | 10 |', '| 2040 | 20 |', '| Total | 40 |');
    expect(verifyTables(md).ok).toBe(false);
  });
  it('indicadores en % no se suman', () => {
    const md = t('| Meta | % |', '|---|---|', '| a | 42% |', '| b | 74% |', '| c | 30% |');
    expect(verifyTables(md).ok).toBe(true);
  });
  it('columnas con menos de 3 números no se comprueban', () => {
    const md = t('| a | b |', '|---|---|', '| x | 1 |', '| Total | 9 |');
    expect(verifyTables(md).ok).toBe(true);
  });
  it('miles con punto: 1.000 + 2.500 = 3.500', () => {
    const md = t('| a | b |', '|---|---|', '| x | 1.000 |', '| y | 2.500 |', '| Total | 3.500 |');
    expect(verifyTables(md).ok).toBe(true);
  });
  it('varias columnas: solo avisa de la que no cuadra', () => {
    const md = t(
      '| Mes | Ingresos | Gastos |',
      '|---|---|---|',
      '| Ene | 10 | 5 |',
      '| Feb | 20 | 5 |',
      '| Total | 30 | 12 |',
    );
    const r = verifyTables(md);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.problem).toMatch(/«Gastos»/);
  });
});

describe('verifyTables: forma de la tabla', () => {
  it('una minoría de filas con otro ancho se tolera (celdas combinadas)', () => {
    const md = t(
      '| a | b | c |',
      '|---|---|---|',
      '| 1 | 2 | 3 |',
      '| 4 | 5 | 6 |',
      '| 7 | 8 | 9 |',
      '| combinada |',
      '| 10 | 11 | 12 |',
    );
    expect(verifyTables(md).ok).toBe(true);
  });
  it('si la mayoría de filas tiene otro ancho, falla', () => {
    const md = t('| a | b | c |', '|---|---|---|', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 | 7 |');
    const r = verifyTables(md);
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.problem).toBe('2 de 3 filas no tienen 3 columnas como la cabecera');
  });
  it('una tabla fantasma (cabecera sin datos) falla', () => {
    const r = verifyTables(t('| a | b |', '|---|---|'));
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.problem).toMatch(/vacía/);
  });
  it('una tabla fantasma con filas en blanco también falla', () => {
    expect(verifyTables(t('| a | b |', '|---|---|', '|  |  |', '|  |  |')).ok).toBe(false);
  });
  it('líneas con barras pero sin separador no son tabla', () => {
    expect(verifyTables('| hola | adiós |\n| x | y |').tables).toBe(0);
  });
  it('texto sin tablas: ok y cero tablas', () => {
    expect(verifyTables('Solo texto.\nOtra línea.')).toEqual({ ok: true, tables: 0, issues: [] });
  });
  it('numera las tablas en orden', () => {
    const r = verifyTables(`${GOOD_SUM}\n\nTexto\n\n${BAD_SUM}`);
    expect(r.tables).toBe(2);
    expect(r.issues.map((x) => x.table)).toEqual([2]);
  });
  it('acepta saltos de línea de Windows', () => {
    expect(verifyTables(BAD_SUM.replace(/\n/g, '\r\n')).ok).toBe(false);
  });
});

describe('verifyWithRetry', () => {
  it('si cuadra a la primera, no reintenta', async () => {
    const seen: (string | undefined)[] = [];
    const r = await verifyWithRetry(async (f) => {
      seen.push(f);
      return GOOD_SUM;
    });
    expect(r).toMatchObject({ verified: true, tries: 1 });
    expect(seen).toEqual([undefined]);
  });
  it('devuelve el informe al modelo y se queda con el intento bueno', async () => {
    const seen: (string | undefined)[] = [];
    const r = await verifyWithRetry(async (f) => {
      seen.push(f);
      return seen.length === 1 ? BAD_SUM : GOOD_SUM;
    });
    expect(r).toMatchObject({ verified: true, tries: 2, text: GOOD_SUM });
    expect(seen[1]).toMatch(
      /Tabla 1: en la columna «Euros» la suma \(100\) no da el total \(108\)/,
    );
  });
  it('como mucho 3 intentos; luego queda marcado sin comprobar', async () => {
    let n = 0;
    const r = await verifyWithRetry(async () => {
      n++;
      return BAD_SUM;
    }, 10);
    expect(n).toBe(3);
    expect(r).toMatchObject({ verified: false, tries: 3, text: BAD_SUM });
  });
  it('si nunca cuadra, se queda con el intento con menos fallos', async () => {
    const worse = `${BAD_SUM}\n\n${BAD_SUM}`;
    const outs = [worse, BAD_SUM, worse];
    const r = await verifyWithRetry(async () => outs.shift() as string);
    expect(r.text).toBe(BAD_SUM);
    expect(r.verified).toBe(false);
  });
});

describe('páginas y aviso', () => {
  const doc = `--- página 1 ---\n${GOOD_SUM}\n\n--- página 2 ---\nHola\n${BAD_SUM}`;
  it('parte por páginas y dice cuál falla', () => {
    expect(splitPages(doc).map((p) => p.page)).toEqual([1, 2]);
    const c = checkPages(doc);
    expect(c.tables).toBe(2);
    expect(c.issues).toEqual([
      { page: 2, table: 1, problem: 'en la columna «Euros» la suma (100) no da el total (108)' },
    ]);
    expect(tableNote(c.issues, true)).toBe(
      'Ojo: no he podido comprobar una tabla; revísala con el PDF original:\n' +
        '- página 2, tabla 1: en la columna «Euros» la suma (100) no da el total (108).',
    );
  });
  it('sin problemas, sin aviso', () => {
    expect(tableNote([], true)).toBe('');
  });
});

describe('ocr_local avisa de las tablas que no cuadran', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-pdfmd-'));
  const pdf = join(root, 'factura.pdf');
  writeFileSync(pdf, 'x');
  const mk = (out: string) =>
    createOcrLocalTool({
      env: { PA_OCR_LOCAL: '1' },
      roots: () => [root],
      run: async () => ({ text: out, pages: 2 }),
    });
  const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('tabla mala: el texto llega entero y con el aviso al final', async () => {
    const r = await mk(`--- página 1 ---\nIntro\n\n--- página 2 ---\n${BAD_SUM}`).execute('1', {
      path: pdf,
    });
    expect(textOf(r)).toContain(BAD_SUM);
    expect(textOf(r)).toMatch(
      /Ojo: no he podido comprobar una tabla[^\n]*\n- página 2, tabla 1: en la columna «Euros»/,
    );
    expect(r.details).toMatchObject({ tables: 1, tablesUnverified: 1 });
  });
  it('tabla buena: sin aviso', async () => {
    const r = await mk(GOOD_SUM).execute('1', { path: pdf });
    expect(textOf(r)).toBe(GOOD_SUM);
    expect(r.details).toMatchObject({ tables: 1, tablesUnverified: 0 });
  });
});
