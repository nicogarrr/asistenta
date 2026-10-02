import { describe, expect, it } from 'vitest';
import { buildNowNote, localTimeZone } from '../src/datecontext.js';

const MADRID = 'Europe/Madrid';

describe('buildNowNote', () => {
  it('a las 00:33 de Madrid del 3/10 hoy es 03/10 y mañana 04/10 (bug off-by-one UTC)', () => {
    // 2026-10-02T22:33Z = 00:33 CEST del sábado 3 de octubre.
    const note = buildNowNote(new Date('2026-10-02T22:33:00Z'), MADRID);
    expect(note).toContain('Hoy: sábado 03/10/2026');
    expect(note).toContain('Mañana: domingo 04/10/2026');
    expect(note).toContain('Ahora: 00:33');
  });

  it.each([
    ['2026-10-02T22:00:00Z', 'sábado 03/10/2026', 'domingo 04/10/2026'], // 00:00
    ['2026-10-03T03:59:00Z', 'sábado 03/10/2026', 'domingo 04/10/2026'], // 05:59
    ['2026-10-03T21:59:00Z', 'sábado 03/10/2026', 'domingo 04/10/2026'], // 23:59
    ['2026-10-03T22:00:00Z', 'domingo 04/10/2026', 'lunes 05/10/2026'], // 00:00 del 4
  ])('madrugada y límites: %s', (iso, hoy, manana) => {
    const note = buildNowNote(new Date(iso), MADRID);
    expect(note).toContain(`Hoy: ${hoy}`);
    expect(note).toContain(`Mañana: ${manana}`);
  });

  it('cruza fin de mes y de año', () => {
    expect(buildNowNote(new Date('2026-12-31T23:30:00Z'), 'UTC')).toContain(
      'Mañana: viernes 01/01/2027',
    );
    expect(buildNowNote(new Date('2028-02-28T10:00:00Z'), 'UTC')).toContain(
      'Mañana: martes 29/02/2028',
    );
  });

  it('respeta el cambio de hora (último domingo de octubre en Madrid)', () => {
    // 2026-10-25 01:30 UTC = 02:30 CET tras retroceder el reloj.
    expect(buildNowNote(new Date('2026-10-25T01:30:00Z'), MADRID)).toContain(
      'Mañana: lunes 26/10/2026',
    );
  });
});

describe('localTimeZone', () => {
  it('usa PA_TIMEZONE si es válida y cae al sistema si no', () => {
    expect(localTimeZone({ PA_TIMEZONE: 'Europe/Madrid' })).toBe('Europe/Madrid');
    expect(localTimeZone({ PA_TIMEZONE: 'No/Existe' })).toBe(localTimeZone({}));
  });
});
