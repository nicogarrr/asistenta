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

// gertru-gaps-8: «a las 9 y diez» quedaba a las 9:00 en la agenda; solo «y media»,
// «y cuarto» y «menos cuarto» llevaban sus minutos.
describe('agenda: minutos dichos en el correo', () => {
  it('«y diez», «y veinte», «menos veinte»', () => {
    expect(at('Reunión el 4 de noviembre a las 9 y diez de la mañana')).toBe('2026-11-04 09:10');
    expect(at('Dentista el 4 de noviembre a las 5 y veinte de la tarde')).toBe('2026-11-04 17:20');
    expect(at('Llamada el 4 de noviembre a las 10 menos veinte de la mañana')).toBe(
      '2026-11-04 09:40',
    );
    expect(at('Cita el 4 de noviembre a las 11 y treinta y cinco de la mañana')).toBe(
      '2026-11-04 11:35',
    );
  });

  it('«y 15» en cifras', () => {
    expect(at('Reunión el 4 de noviembre a las 10 y 15 de la mañana')).toBe('2026-11-04 10:15');
  });

  it('lo de antes sigue igual', () => {
    expect(at('Reunión el 4 de noviembre a las 9 y media')).toBe('2026-11-04 09:30');
    expect(at('Reunión el 4 de noviembre a las 5 y cuarto de la tarde')).toBe('2026-11-04 17:15');
    expect(at('Reunión el 4 de noviembre a las 10:30')).toBe('2026-11-04 10:30');
  });
});
