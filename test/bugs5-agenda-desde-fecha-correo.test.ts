import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// Domingo 1 de noviembre de 2026, 10:00 en Madrid. La agenda lee correos de 3 días.
const now = Date.parse('2026-11-01T10:00:00+01:00');
const friday = Date.parse('2026-10-30T12:00:00+01:00');
const thursday = Date.parse('2026-10-29T12:00:00+01:00');
const madrid = (ms: number): string =>
  new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
const when = (text: string, at: number): string[] =>
  extractCommitments([{ id: '1', subject: '', text, from: 'clinica@ejemplo.es', at } as never], {
    now,
    timeZone: 'Europe/Madrid',
  }).map((c) => madrid(c.at));

describe('agenda: «mañana» o «el viernes» se cuentan desde el día del correo', () => {
  it('una cita que ya pasó no reaparece en la semana siguiente', () => {
    // Antes: lunes 2 a las 10:00 (el «mañana» del viernes era el sábado, ya pasado).
    expect(when('Le esperamos mañana a las 10:00 para su revisión', friday)).toEqual([]);
    // Antes: viernes 6 (el «viernes» del jueves era el 30, ya pasado).
    expect(when('Su cita es el viernes a las 10:00', thursday)).toEqual([]);
    expect(when('Reunión hoy a las 18:00', friday)).toEqual([]);
  });

  it('lo que aún no ha llegado sigue en su día', () => {
    expect(when('Le esperamos pasado mañana a las 18:00', friday)).toEqual(['2026-11-01 18:00']);
    expect(when('Su cita es el martes a las 10:00', thursday)).toEqual(['2026-11-03 10:00']);
    expect(when('Su cita es el 12/11 a las 10:00', friday)).toEqual(['2026-11-12 10:00']);
  });

  it('sin fecha fiable del correo se cuenta desde hoy, como antes', () => {
    expect(when('Le esperamos mañana a las 10:00', 0)).toEqual(['2026-11-02 10:00']);
    expect(when('Le esperamos mañana a las 10:00', now + 86_400_000)).toEqual(['2026-11-02 10:00']);
    expect(when('Le esperamos mañana a las 10:00', now - 3_600_000)).toEqual(['2026-11-02 10:00']);
  });
});
