import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// Friday 30 Oct 2026, 10:00 in Madrid.
const now = Date.parse('2026-10-30T09:00:00Z');

function at(subject: string): string | undefined {
  const found = extractCommitments(
    [
      {
        id: 'm',
        from: 'ana@example.com',
        to: [],
        subject,
        text: '',
        at: now,
        seen: false,
        folder: 'INBOX',
      },
    ],
    { now, timeZone: 'Europe/Madrid', minConfidence: 0 },
  );
  const first = found[0];
  if (!first) return undefined;
  return new Date(first.at).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
}

describe('fechas y horas del correo: «de 10:00», «esta tarde», «17.30 h»', () => {
  it('«el 4 de noviembre de 10:00 a 12:00» es a las 10, no el año 2010', () => {
    expect(at('Reunión el 4 de noviembre de 10:00 a 12:00')).toBe('2026-11-04 10:00');
    expect(at('Reunión el 4 de noviembre de 10 a 12')).toBe('2026-11-04 09:00');
  });

  it('un año escrito sigue valiendo', () => {
    expect(at('Cita el 15 de noviembre de 2026')).toBe('2026-11-15 09:00');
    expect(at('Cita el 15 de noviembre de 2025')).toBeUndefined();
  });

  it('«esta tarde/mañana/noche a las N» es hoy a esa hora', () => {
    expect(at('Reunión esta tarde a las 5')).toBe('2026-10-30 17:00');
    expect(at('Reunión esta mañana a las 11')).toBe('2026-10-30 11:00');
    expect(at('Reunión esta noche a las 9:30')).toBe('2026-10-30 21:30');
  });

  it('«esta mañana» sin hora no es mañana', () => {
    expect(at('Esta mañana te envié el presupuesto, revísalo')).toBeUndefined();
    expect(at('Mañana por la mañana a las 9 reunión')).toBe('2026-10-31 09:00');
  });

  it('«17.30 h» es una hora; «12.50 €» no', () => {
    expect(at('Reunión el 4 de noviembre, 17.30 h')).toBe('2026-11-04 17:30');
    expect(at('Pago el 4 de noviembre: 12.50 €')).toBe('2026-11-04 09:00');
  });
});
