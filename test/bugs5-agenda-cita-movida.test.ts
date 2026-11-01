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
        from: 'clinica@ejemplo.es',
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
  ).map((c) => madrid(c.at));

describe('agenda: una cita que se mueve va a la fecha nueva', () => {
  it('la fecha detrás de «se mueve al», «aplazada al», «pasa al» es la que vale', () => {
    // Antes: todas iban a la fecha vieja, con la hora nueva.
    expect(when('La reunión del lunes 2 se mueve al martes 3 a las 10')).toEqual([
      '2026-11-03 10:00',
    ]);
    expect(when('Su cita del 5 de noviembre se ha cambiado al 12 de noviembre a las 9:30')).toEqual(
      ['2026-11-12 09:30'],
    );
    expect(when('Su cita del día 5 queda aplazada al día 12 a las 9:30')).toEqual([
      '2026-11-12 09:30',
    ]);
    expect(when('Cambio de cita: el 05/11 pasa al 12/11 a las 17:00')).toEqual([
      '2026-11-12 17:00',
    ]);
    expect(when('Su cita del lunes se traslada al jueves a las 11:00')).toEqual([
      '2026-11-05 11:00',
    ]);
    expect(
      when('Su cita del 5 de noviembre se cancela. Nueva fecha: 12 de noviembre a las 10:00'),
    ).toEqual(['2026-11-12 10:00']);
  });

  it('sin palabras de cambio sigue valiendo la primera fecha', () => {
    expect(
      when('Le confirmamos su cita el 12 de noviembre a las 10:00. El 5 de noviembre cerramos.'),
    ).toEqual(['2026-11-12 10:00']);
    expect(when('Le confirmamos su cita el lunes 9 a las 10:00')).toEqual(['2026-11-09 10:00']);
  });
});
