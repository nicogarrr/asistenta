import { describe, expect, it } from 'vitest';
import { normaliseTime, resolveDay } from '../src/tasks/board.js';

// Sábado 31 oct 2026 a mediodía (hora local).
const NOW = new Date(2026, 9, 31, 12, 0);

// gertru-gaps-8: «a las 8 y diez» no se entendía en el tablero, «esta mañana» se iba a
// mañana, y «dentro de quince días» o «mañana por la tarde» no se leían.
describe('tablero: horas con minutos y días con parte del día', () => {
  it('minutos en palabras y en cifras', () => {
    expect(normaliseTime('a las 8 y diez')).toBe('08:10');
    expect(normaliseTime('a las 9 menos veinte')).toBe('08:40');
    expect(normaliseTime('a las 8 y 15')).toBe('08:15');
    expect(normaliseTime('a las 6 y veinticinco de la tarde')).toBe('18:25');
    expect(normaliseTime('a las nueve y treinta y cinco')).toBe('09:35');
    expect(normaliseTime('a las 10 en punto')).toBe('10:00');
    expect(normaliseTime('a las 8 y 60')).toBeNull();
  });

  it('lo de antes sigue igual', () => {
    expect(normaliseTime('a las 8 y media')).toBe('08:30');
    expect(normaliseTime('a las 9 menos cuarto')).toBe('08:45');
    expect(normaliseTime('a las 5 y cuarto de la tarde')).toBe('17:15');
    expect(normaliseTime('a las 12 de la noche')).toBe('00:00');
  });

  it('«esta mañana/tarde/noche» es hoy', () => {
    expect(resolveDay('esta mañana', NOW)).toBe('2026-10-31');
    expect(resolveDay('esta tarde', NOW)).toBe('2026-10-31');
    expect(resolveDay('para esta noche', NOW)).toBe('2026-10-31');
    expect(resolveDay('mañana', NOW)).toBe('2026-11-01');
  });

  it('«mañana por la tarde», «hoy por la noche»', () => {
    expect(resolveDay('mañana por la tarde', NOW)).toBe('2026-11-01');
    expect(resolveDay('hoy por la noche', NOW)).toBe('2026-10-31');
    expect(resolveDay('pasado mañana por la mañana', NOW)).toBe('2026-11-02');
  });

  it('«dentro de quince días»', () => {
    expect(resolveDay('dentro de quince días', NOW)).toBe('2026-11-15');
    expect(resolveDay('en veinte días', NOW)).toBe('2026-11-20');
  });
});
