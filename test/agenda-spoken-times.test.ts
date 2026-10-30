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

describe('horas habladas en el correo (agenda)', () => {
  it('«de la tarde» y «de la noche» suman 12 horas', () => {
    expect(at('Llamada el 4 de noviembre a las 8 de la tarde')).toBe('2026-11-04 20:00');
    expect(at('Reunión el 4 de noviembre a las 10 de la noche')).toBe('2026-11-04 22:00');
  });

  it('«de la mañana» deja la hora temprana como está', () => {
    expect(at('Reunión el 4 de noviembre a las 7 de la mañana')).toBe('2026-11-04 07:00');
  });

  it('«y media», «y cuarto» y «menos cuarto» llevan sus minutos', () => {
    expect(at('Reunión el 4 de noviembre a las 9 y media')).toBe('2026-11-04 09:30');
    expect(at('Reunión el 4 de noviembre a las 5 y cuarto de la tarde')).toBe('2026-11-04 17:15');
    expect(at('Reunión el 4 de noviembre a las 10 menos cuarto')).toBe('2026-11-04 09:45');
  });

  it('«9:30h», «06.15» y «18h» se leen como están escritas', () => {
    expect(at('Reunión el 4 de noviembre a las 9:30h')).toBe('2026-11-04 09:30');
    expect(at('Vuelo el 4 de noviembre a las 06.15')).toBe('2026-11-04 06:15');
    expect(at('Reunión el 4/11 a las 18h')).toBe('2026-11-04 18:00');
  });

  it('«medianoche» y «las 12 de la noche» son las 00:00 de la noche siguiente', () => {
    expect(at('Cena de empresa el sábado a medianoche')).toBe('2026-11-01 00:00');
    expect(at('Reunión con Ana el lunes a las 12 de la noche')).toBe('2026-11-03 00:00');
  });

  it('lo que ya iba bien sigue igual', () => {
    expect(at('Reunión el 5 de noviembre a las 2')).toBe('2026-11-05 14:00');
    expect(at('Cita médica mañana a las 12')).toBe('2026-10-31 12:00');
    expect(at('Reunión el 4 de noviembre a las 18:27')).toBe('2026-11-04 18:27');
    // A price is never a clock.
    expect(at('Factura de 12.50 € vence el 4 de noviembre')).toBe('2026-11-04 09:00');
  });
});
