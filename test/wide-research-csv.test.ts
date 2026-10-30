import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type WideReport, wideCsvAttachment } from '../src/research/wide-research.js';

const report = (rows: WideReport['rows'], question = 'Precio y garantía (España)'): WideReport => ({
  question,
  rows,
  sources: [],
  budgetExhausted: false,
  usedLlm: true,
});

describe('F8: /investiga amplio manda la tabla como CSV', () => {
  it('BOM UTF-8, cabecera, CRLF y comillas escapadas', () => {
    const a = wideCsvAttachment(
      report([
        { item: 'iPhone 16', cell: '959 € [1]' } as never,
        { item: 'Pixel "9"', cell: 'garantía 2 años, 899 €' } as never,
      ]),
    );
    expect(a).not.toBeNull();
    const text = a?.bytes.toString('utf8') ?? '';
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text.slice(1)).toBe(
      'elemento,resultado\r\n"iPhone 16","959 € [1]"\r\n"Pixel ""9""","garantía 2 años, 899 €"\r\n',
    );
    expect(a?.filename).toBe('investigacion-precio-y-garantia-espana.csv');
    expect(a?.caption).toContain('2 filas');
  });

  it('sin filas no hay adjunto; nombre corto y seguro aunque la pregunta sea rara', () => {
    expect(wideCsvAttachment(report([]))).toBeNull();
    const a = wideCsvAttachment(report([{ item: 'a', cell: 'b' } as never], '../../¿¿??'));
    expect(a?.filename).toBe('investigacion-tabla.csv');
    expect(a?.caption).toContain('1 fila)');
    const long = wideCsvAttachment(report([{ item: 'a', cell: 'b' } as never], 'x'.repeat(200)));
    expect(long?.filename.length).toBeLessThanOrEqual('investigacion-.csv'.length + 40);
  });

  it('el daemon la adjunta en Telegram después del informe, sin romperlo si falla', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = src.indexOf('renderWideReport(report)');
    const j = src.indexOf('wideCsvAttachment(report)');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(src.slice(j, j + 600)).toMatch(/sendDocumentBytes[\s\S]*\.catch\(/);
  });
});
