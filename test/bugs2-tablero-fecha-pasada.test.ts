import { describe, expect, it } from 'vitest';
import { resolveDay } from '../src/tasks/board.js';

// asis-bugs-2: en el tablero, «para el 1/1» dicho el 1 de noviembre de 2026 quedaba en el
// 1 de enero de 2026, que ya pasó (con nombre de mes, «el 1 de enero», ya iba a 2027). Y
// «15-11-2026» con guiones no se entendía.
const now = new Date('2026-11-01T10:00:00+01:00');

describe('tablero: día con barra, guion o punto', () => {
  it('dd/mm ya pasado este año: el del año que viene', () => {
    expect(resolveDay('1/1', now)).toBe('2027-01-01');
    expect(resolveDay('el 15/10', now)).toBe('2027-10-15');
    expect(resolveDay('31/12', now)).toBe('2026-12-31');
    expect(resolveDay('1/11', now)).toBe('2026-11-01');
  });

  it('con año escrito, ese año aunque haya pasado', () => {
    expect(resolveDay('1/1/2026', now)).toBe('2026-01-01');
  });

  it('guion o punto como la barra', () => {
    expect(resolveDay('15-11-2026', now)).toBe('2026-11-15');
    expect(resolveDay('15.11.2026', now)).toBe('2026-11-15');
    expect(resolveDay('3-12', now)).toBe('2026-12-03');
  });

  it('29/2 sin año: el próximo que exista', () => {
    expect(resolveDay('29/2', now)).toBe('2028-02-29');
    expect(resolveDay('29/2/2028', now)).toBe('2028-02-29');
  });
});
