import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// Domingo 1 de noviembre de 2026, 10:00 en Madrid.
const now = Date.parse('2026-11-01T10:00:00+01:00');
const madrid = (ms: number): string =>
  new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
const when = (text: string): string[] =>
  extractCommitments(
    [
      {
        id: '1',
        from: 'reservas@ejemplo.com',
        to: [],
        subject: '',
        text,
        at: now,
        seen: false,
        folder: 'INBOX',
      },
    ],
    {
      now,
      timeZone: 'Europe/Madrid',
    },
  ).map((c) => madrid(c.at) + (c.timed ? '' : ' sin hora'));

describe('agenda: «3:00 PM» y «17h30»', () => {
  it('la marca PM/AM detrás de la hora cuenta', () => {
    // Antes: 03:00 y 03:30, de madrugada.
    expect(when('Your appointment is on Monday, November 9 at 3:00 PM')).toEqual([
      '2026-11-09 15:00',
    ]);
    expect(when('Your appointment: Nov 9, 3:30 pm')).toEqual(['2026-11-09 15:30']);
    expect(when('Cita el 9 de noviembre a las 4:30 p. m.')).toEqual(['2026-11-09 16:30']);
    expect(when('Your flight departs on November 9 at 12:15 AM')).toEqual(['2026-11-09 00:15']);
    expect(when('Lunch on November 9 at 12:30 PM')).toEqual(['2026-11-09 12:30']);
  });

  it('«17h30» es una hora', () => {
    // Antes: la cita quedaba sin hora.
    expect(when('Su cita es el jueves 5 de noviembre a las 17h30')).toEqual(['2026-11-05 17:30']);
  });

  it('lo de siempre sigue igual', () => {
    expect(when('Cita el 9 de noviembre a las 10:00 a mi casa')).toEqual(['2026-11-09 10:00']);
    expect(when('Cita el 9 de noviembre a las 15:00 pm')).toEqual(['2026-11-09 15:00']);
    expect(when('Your table: November 9, 7pm')).toEqual(['2026-11-09 19:00']);
    expect(when('Su cita es el 12/11 a las 17.30h')).toEqual(['2026-11-12 17:30']);
  });
});
