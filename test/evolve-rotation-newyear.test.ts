import { describe, expect, it } from 'vitest';
import { isoWeek } from '../src/evolve/archive.js';
import { cycleOfWeek } from '../src/evolve/battery-gate.js';

// El turno de los heavy que rotan es cycleOfWeek(semana) % 3. Con el número de semana dentro
// del año, en Año Nuevo se repetía un turno (2026-W53 → 2, 2027-W01 → 1; 2027-W52 → 1,
// 2028-W01 → 1) y los heavy de otro tercio esperaban 4 semanas en vez de 3.

const slot = (week: string) => cycleOfWeek(week) % 3;

describe('rotación de heavy en Año Nuevo', () => {
  it('cada semana ISO avanza un turno, también al cambiar de año (2024–2032)', () => {
    let d = new Date(Date.UTC(2024, 0, 3, 12));
    let prev = isoWeek(d);
    const saltos: string[] = [];
    for (let i = 0; i < 9 * 53; i++) {
      d = new Date(d.getTime() + 7 * 86_400_000);
      const week = isoWeek(d);
      if (slot(week) !== (slot(prev) + 1) % 3) saltos.push(`${prev}→${week}`);
      prev = week;
    }
    expect(saltos).toEqual([]);
  });

  it('2026-W53 y 2027-W01 son turnos distintos y seguidos', () => {
    expect(slot('2027-W01')).toBe((slot('2026-W53') + 1) % 3);
  });
});
