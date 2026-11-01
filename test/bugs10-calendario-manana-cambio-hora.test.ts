import { describe, expect, it } from 'vitest';
import { confirmacionCalendario } from '../src/agenda/calendario-pasado.js';

// La confirmación de /calendario decidía «mañana» con «ahora + 24 h». La noche del cambio de
// hora de otoño, a las 0:30, «mañana a las 10» salía «el 26/10»; la víspera del de primavera,
// a las 23:30, algo de pasado mañana salía como «mañana». Ahora es el día siguiente del calendario.

const Z = 'Europe/Madrid';

describe('/calendario: «mañana» en la confirmación es el día siguiente del calendario', () => {
  it('a las 0:30 del día del cambio de hora de otoño', () => {
    const out = confirmacionCalendario(
      'Dentista',
      new Date('2026-10-26T09:00:00Z'),
      new Date('2026-10-24T22:30:00Z'),
      Z,
    );
    expect(out).toContain('Dentista — mañana a las 10:00.');
  });

  it('a las 23:30 de la víspera del cambio de hora de primavera', () => {
    const out = confirmacionCalendario(
      'Dentista',
      new Date('2026-03-30T08:00:00Z'),
      new Date('2026-03-28T22:30:00Z'),
      Z,
    );
    expect(out).toContain('Dentista — el 30/03 a las 10:00.');
  });
});
