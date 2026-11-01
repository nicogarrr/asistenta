import { describe, expect, it } from 'vitest';
import { resolveDay } from '../src/tasks/board.js';

const nov1 = new Date(2026, 10, 1, 10, 0);

describe('tablero: días sin año o sin mes que este año/mes no existen', () => {
  it('«29/2» dicho en noviembre de 2026 va al próximo 29 de febrero (2028)', () => {
    expect(resolveDay('29/2', nov1)).toBe('2028-02-29');
    expect(resolveDay('el 29/02', new Date(2027, 0, 10, 10, 0))).toBe('2028-02-29');
  });

  it('«el 31» dicho en noviembre (que tiene 30) va al 31 de diciembre', () => {
    expect(resolveDay('el 31', nov1)).toBe('2026-12-31');
    expect(resolveDay('el 30', new Date(2027, 1, 10, 10, 0))).toBe('2027-03-30');
  });

  it('las fechas imposibles o con año siguen rechazándose', () => {
    expect(resolveDay('31/11', nov1)).toBeNull();
    expect(resolveDay('30/2', nov1)).toBeNull();
    expect(resolveDay('29/02/2027', nov1)).toBeNull();
    expect(resolveDay('el 32', nov1)).toBeNull();
  });

  it('lo que ya funcionaba no cambia', () => {
    expect(resolveDay('1/1', nov1)).toBe('2027-01-01');
    expect(resolveDay('el 15', nov1)).toBe('2026-11-15');
    expect(resolveDay('29/02/2028', nov1)).toBe('2028-02-29');
  });
});
