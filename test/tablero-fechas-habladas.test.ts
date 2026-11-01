import { describe, expect, it } from 'vitest';
import { normaliseTime, resolveDay } from '../src/tasks/board.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

describe('tablero: fechas y horas como se dicen', () => {
  it('entiende el mes por su nombre', () => {
    expect(resolveDay('12 de noviembre', NOW)).toBe('2026-11-12');
    expect(resolveDay('el 3 de dic', NOW)).toBe('2026-12-03');
    expect(resolveDay('5 de enero', NOW)).toBe('2027-01-05');
    expect(resolveDay('el 2 de marzo de 2027', NOW)).toBe('2027-03-02');
    expect(resolveDay('jueves 12 de noviembre', NOW)).toBe('2026-11-12');
    expect(resolveDay('el jueves 5', NOW)).toBe('2026-11-05');
    expect(resolveDay('31 de noviembre', NOW)).toBeNull();
    expect(resolveDay('3 de brumario', NOW)).toBeNull();
  });

  it('entiende «dentro de» y el finde', () => {
    expect(resolveDay('dentro de 3 días', NOW)).toBe('2026-11-03');
    expect(resolveDay('en dos semanas', NOW)).toBe('2026-11-14');
    expect(resolveDay('dentro de una semana', NOW)).toBe('2026-11-07');
    expect(resolveDay('este finde', new Date(2026, 9, 28, 12))).toBe('2026-10-31');
    expect(resolveDay('el fin de semana', NOW)).toBe('2026-10-31');
  });

  it('entiende la hora dicha con palabras', () => {
    expect(normaliseTime('a las 10')).toBe('10:00');
    expect(normaliseTime('5 de la tarde')).toBe('17:00');
    expect(normaliseTime('a las 9 de la noche')).toBe('21:00');
    expect(normaliseTime('10 de la mañana')).toBe('10:00');
    expect(normaliseTime('las diez y media')).toBe('10:30');
    expect(normaliseTime('cinco y cuarto de la tarde')).toBe('17:15');
    expect(normaliseTime('las 8 menos cuarto')).toBe('07:45');
    expect(normaliseTime('mediodía')).toBe('12:00');
    expect(normaliseTime('17h')).toBe('17:00');
    expect(normaliseTime('5pm')).toBe('17:00');
    expect(normaliseTime('la una')).toBe('01:00');
    expect(normaliseTime('10:30')).toBe('10:30');
    expect(normaliseTime('a las tantas')).toBeNull();
    expect(normaliseTime('25 de la tarde')).toBeNull();
  });
});
