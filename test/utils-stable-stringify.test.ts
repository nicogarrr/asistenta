import { describe, expect, it } from 'vitest';
import { stableStringify } from '../src/utils.js';

// The previous implementation, kept verbatim to prove that the fix does not
// change any fingerprint for JSON-shaped values (tool args come from JSON).
function legacy(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(legacy).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${legacy(record[key])}`)
    .join(',')}}`;
}

describe('stableStringify', () => {
  it('es JSON valido y omite claves undefined como JSON.stringify', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify({ a: undefined })).toBe('{}');
    expect(stableStringify([1, undefined, () => 1])).toBe('[1,null,null]');
    expect(() =>
      JSON.parse(stableStringify({ x: { y: undefined }, z: [undefined] })),
    ).not.toThrow();
  });

  it('dos fechas distintas no comparten huella (antes ambas eran "{}")', () => {
    const a = stableStringify({ cuando: new Date('2026-10-30T10:00:00Z') });
    const b = stableStringify({ cuando: new Date('2026-11-30T10:00:00Z') });
    expect(a).not.toBe(b);
    expect(a).toBe('{"cuando":"2026-10-30T10:00:00.000Z"}');
  });

  it('ordena claves a cualquier profundidad', () => {
    expect(stableStringify({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: 'x' })).toBe(
      '{"a":"x","b":{"c":[{"e":2,"f":1}],"d":1}}',
    );
  });

  it('para valores venidos de JSON la salida es identica a la version anterior (huellas guardadas)', () => {
    const samples = [
      '{"action":"click","x":10,"y":20}',
      '{"command":"dir C:\\\\","cwd":null,"timeout":30}',
      '[1,"dos",{"z":true,"a":[null,false,0.5]}]',
      '{"url":"https://example.com/?q=ñ","headers":{"B":"2","A":"1"}}',
      '"texto"',
      '42',
      'null',
      '{}',
      '[]',
    ];
    for (const raw of samples) {
      const v = JSON.parse(raw);
      expect(stableStringify(v)).toBe(legacy(v));
    }
  });
});
