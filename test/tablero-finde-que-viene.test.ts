import { describe, expect, it } from 'vitest';
import { resolveDay } from '../src/tasks/board.js';

describe('tablero: «el finde que viene»', () => {
  it('es el sábado de la semana que viene', () => {
    // Miércoles 4 nov 2026: este finde es el 7; el que viene, el 14.
    const wed = new Date(2026, 10, 4, 12);
    expect(resolveDay('el finde', wed)).toBe('2026-11-07');
    expect(resolveDay('el finde que viene', wed)).toBe('2026-11-14');
    expect(resolveDay('el próximo fin de semana', wed)).toBe('2026-11-14');
    expect(resolveDay('para el fin de semana que viene', wed)).toBe('2026-11-14');
    expect(resolveDay('el siguiente finde', wed)).toBe('2026-11-14');
  });

  it('un sábado o un domingo, el que viene es el de la semana siguiente', () => {
    expect(resolveDay('el finde que viene', new Date(2026, 9, 31, 12))).toBe('2026-11-07');
    expect(resolveDay('el finde que viene', new Date(2026, 10, 1, 12))).toBe('2026-11-07');
  });
});
