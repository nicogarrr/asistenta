import { describe, expect, it } from 'vitest';
import { dentroDeEs } from '../src/tools/reminder.js';

// Un recordatorio para mañana a las 21:00, mirado hoy a las 9:00 (36 h), salía «(en 2 d)»:
// se redondeaban las horas a días. Pasado un día, ahora se cuenta por días del calendario:
// «mañana», «pasado mañana», «en 3 d».

const at = (iso: string) => new Date(iso).getTime();

describe('recordatorios: «en N d» por días del calendario', () => {
  it('36 h que caen mañana dicen «mañana»', () => {
    const now = at('2026-11-01T08:00:00Z'); // dom 9:00 en Madrid
    expect(dentroDeEs(36 * 3_600_000, now)).toBe('mañana');
  });

  it('pasado mañana y más allá', () => {
    const now = at('2026-11-01T08:00:00Z');
    expect(dentroDeEs(at('2026-11-03T07:00:00Z') - now, now)).toBe('pasado mañana');
    expect(dentroDeEs(at('2026-11-04T20:00:00Z') - now, now)).toBe('en 3 d');
  });

  it('menos de un día sigue en horas', () => {
    const now = at('2026-11-01T08:00:00Z');
    expect(dentroDeEs(21 * 3_600_000, now)).toBe('en 21 h');
  });
});
