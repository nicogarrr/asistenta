import { describe, expect, it } from 'vitest';
import { OutputCollector } from '../src/tools/shell.js';

function collect(text: string, window: number, chunk = 37): string {
  const c = new OutputCollector(window);
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i += chunk) c.push(buf.subarray(i, i + chunk));
  return c.text();
}

function marker(out: string): { bytes: number; lines: number | null; shown: number } {
  const m =
    /\n\.\.\. \[(\d+) bytes(?: \(~(\d+) lines\))? omitted from the middle\.[^\n]*\] \.\.\.\n/.exec(
      out,
    );
  if (!m) throw new Error('sin aviso de omisión');
  return {
    bytes: Number(m[1]),
    lines: m[2] ? Number(m[2]) : null,
    shown: Buffer.byteLength(out) - Buffer.byteLength(m[0]),
  };
}

const numbered = (n: number) =>
  `${Array.from({ length: n }, (_, i) => `line ${String(i).padStart(5, '0')}`).join('\n')}\n`;

describe('shell: el aviso de salida recortada cuenta lo que de verdad no se ve', () => {
  it('bytes omitidos + bytes mostrados = bytes que emitió el comando (incluidos los trozos de línea recortados)', () => {
    const text = numbered(100);
    const m = marker(collect(text, 100));
    expect(m.bytes + m.shown).toBe(Buffer.byteLength(text));
  });

  it('las «líneas omitidas» estiman el hueco, no las líneas de la cabeza', () => {
    const text = numbered(10_000);
    const out = collect(text, 6 * 1024, 4096);
    const m = marker(out);
    const shownLines = out.split('\n').filter((l) => /^line \d{5}$/.test(l)).length;
    const realOmitted = 10_000 - shownLines;
    expect(m.lines).not.toBeNull();
    expect(Math.abs((m.lines ?? 0) - realOmitted)).toBeLessThanOrEqual(realOmitted * 0.05);
  });

  it('con caracteres de varios bytes la cuenta sigue cuadrando en bytes', () => {
    const text = `${Array.from({ length: 300 }, (_, i) => `canción ñandú ${i}`).join('\n')}\n`;
    const m = marker(collect(text, 200, 7));
    expect(m.bytes + m.shown).toBe(Buffer.byteLength(text));
  });

  it('una sola línea enorme sin saltos: avisa en bytes y no inventa un número de líneas', () => {
    const text = 'x'.repeat(50_000);
    const m = marker(collect(text, 1000));
    expect(m.lines).toBeNull();
    expect(m.bytes + m.shown).toBe(50_000);
  });

  it('salida que cabe entera: sin aviso y sin recortes', () => {
    const text = numbered(5);
    expect(collect(text, 1000)).toBe(text);
  });
});
