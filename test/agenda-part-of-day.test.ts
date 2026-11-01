import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// Friday 30 Oct 2026, 10:00 in Madrid.
const now = Date.parse('2026-10-30T09:00:00Z');

function hit(subject: string) {
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
  return {
    at: new Date(first.at).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16),
    timed: first.timed,
  };
}

describe('«por la tarde/noche» junto a una fecha sin hora', () => {
  it('«el sábado por la tarde» es la tarde del sábado, no las 09:00', () => {
    expect(hit('Quedamos el sábado por la tarde')).toEqual({
      at: '2026-10-31 16:00',
      timed: false,
    });
  });

  it('«por la noche» va a la noche y «por la mañana» sigue a las 09:00', () => {
    expect(hit('Cena el viernes 6 de noviembre por la noche')?.at).toBe('2026-11-06 21:00');
    expect(hit('Revisión el lunes por la mañana')?.at).toBe('2026-11-02 09:00');
  });

  it('también delante de la fecha: «por la tarde del martes»', () => {
    expect(hit('Te llamo por la tarde del martes')?.at).toBe('2026-11-03 16:00');
  });

  it('una hora escrita manda sobre «por la tarde»', () => {
    expect(hit('Quedamos el sábado por la tarde a las 18:30')).toEqual({
      at: '2026-10-31 18:30',
      timed: true,
    });
  });

  it('«por la mañana» sola sigue sin ser una fecha (no es «mañana»)', () => {
    expect(hit('Me gusta tomar café por la mañana')).toBeUndefined();
    expect(hit('Siempre llama por la tarde')).toBeUndefined();
  });

  it('una franja lejos de la fecha no la mueve', () => {
    const pad = ' bla'.repeat(60);
    expect(hit(`Reunión el lunes 2 de noviembre.${pad} Yo suelo salir por la tarde`)?.at).toBe(
      '2026-11-02 09:00',
    );
  });
});
