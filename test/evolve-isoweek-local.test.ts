import { describe, expect, it } from 'vitest';
import { isoWeek } from '../src/evolve/archive.js';

// La semana de la evolución (archivo, historial de la batería, turno de los pesados) se nombraba
// con la fecha UTC. El lunes entre las 00:00 y las 01:00/02:00 de Madrid todavía era domingo en
// UTC: un /evolucion ahora a esa hora se apuntaba en la semana anterior.

describe('isoWeek en hora local', () => {
  it('el lunes de madrugada en Madrid ya es la semana nueva', () => {
    // Lunes 2-nov-2026, 00:30 en Madrid (CET) = domingo 1-nov 23:30 UTC.
    expect(isoWeek(new Date('2026-11-01T23:30:00Z'), 'Europe/Madrid')).toBe('2026-W45');
    // Lunes 6-abr-2026, 01:30 en Madrid (CEST) = domingo 5-abr 23:30 UTC.
    expect(isoWeek(new Date('2026-04-05T23:30:00Z'), 'Europe/Madrid')).toBe('2026-W15');
  });
  it('el domingo por la noche sigue siendo la misma semana', () => {
    expect(isoWeek(new Date('2026-11-01T22:30:00Z'), 'Europe/Madrid')).toBe('2026-W44');
    expect(isoWeek(new Date('2026-11-01T23:30:00Z'), 'UTC')).toBe('2026-W44');
  });
  it('fin de año: el 31-dic-2026 de madrugada sigue en la W53 de 2026', () => {
    expect(isoWeek(new Date('2026-12-31T12:00:00Z'), 'Europe/Madrid')).toBe('2026-W53');
    expect(isoWeek(new Date('2027-01-03T23:30:00Z'), 'Europe/Madrid')).toBe('2027-W01');
  });
});
