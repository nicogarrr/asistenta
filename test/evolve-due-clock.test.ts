import { describe, expect, it } from 'vitest';
import { isEvolveDue } from '../src/evolve/run.js';

// Domingo 1 nov 2026, 04:00 en Madrid.
const sunday = new Date('2026-11-01T03:00:00Z');
const day = 24 * 3_600_000;

describe('isEvolveDue con una última ejecución imposible', () => {
  it('una fecha futura (reloj mal puesto una vez) no para el ciclo semanal', () => {
    expect(isEvolveDue(sunday, sunday.getTime() + 200 * day)).toBe(true);
  });
  it('un valor que no es número tampoco', () => {
    expect(isEvolveDue(sunday, Number.NaN)).toBe(true);
  });
  it('lo normal no cambia', () => {
    expect(isEvolveDue(sunday, sunday.getTime() - 7 * day)).toBe(true);
    expect(isEvolveDue(sunday, sunday.getTime() - 2 * day)).toBe(false);
    expect(isEvolveDue(new Date('2026-11-02T03:00:00Z'), Number.NaN)).toBe(false);
  });
});
