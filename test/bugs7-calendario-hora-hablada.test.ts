import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// /calendario dicho normal: «a las 9 y media médico» quedaba a las 09:00 con el título
// «y media médico», y «a las ocho», «a la una», «a mediodía» o «a las cinco de la tarde»
// no se entendían y volvía a preguntar.
const NOW = new Date('2026-11-01T10:00:00Z'); // domingo 1 nov, 11:00 en Madrid
const TZ = 'Europe/Madrid';

function said(text: string): string | null {
  const r = parseFechaCalendario(text, NOW, TZ);
  if (!r) return null;
  const at = r.start.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
  return `${at} | ${r.title}`;
}

describe('/calendario: la hora dicha como se habla', () => {
  it('«y media», «y cuarto» y «menos cuarto»', () => {
    expect(said('el 5 de noviembre a las 9 y media médico')).toBe('2026-11-05 09:30 | médico');
    expect(said('mañana a las 10 y cuarto reunión')).toBe('2026-11-02 10:15 | reunión');
    expect(said('mañana a las 6 menos cuarto de la tarde clase')).toBe('2026-11-02 17:45 | clase');
  });

  it('la hora en letras', () => {
    expect(said('mañana a las ocho dentista')).toBe('2026-11-02 08:00 | dentista');
    expect(said('el viernes a las cinco de la tarde revisión')).toBe('2026-11-06 17:00 | revisión');
    expect(said('mañana a la una comida con Ana')).toBe('2026-11-02 13:00 | comida con Ana');
    expect(said('el lunes a las once y media llamada')).toBe('2026-11-02 11:30 | llamada');
  });

  it('«a mediodía»', () => {
    expect(said('mañana a mediodía comida')).toBe('2026-11-02 12:00 | comida');
  });

  it('lo de siempre sigue igual', () => {
    expect(said('el lunes a las 10:30 reunión')).toBe('2026-11-02 10:30 | reunión');
    expect(said('mañana a las 5 de la tarde café')).toBe('2026-11-02 17:00 | café');
    expect(said('el 3/11 a las 18 gym')).toBe('2026-11-03 18:00 | gym');
  });
});
