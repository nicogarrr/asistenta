import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// /calendario: «el próximo lunes a las 10», «el viernes 6 a las 10» y «esta noche a las
// 10» no se entendían y volvía a preguntar. Y «a la una y media de la noche» quedaba a
// las 13:30.
const NOW = new Date('2026-11-01T10:00:00Z'); // domingo 1 nov, 11:00 en Madrid
const TZ = 'Europe/Madrid';

function said(text: string): string | null {
  const r = parseFechaCalendario(text, NOW, TZ);
  if (!r) return null;
  const at = r.start.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
  return `${at} | ${r.title}`;
}

describe('/calendario: más formas de decir el día', () => {
  it('«el próximo lunes» es el lunes que viene', () => {
    expect(said('el próximo lunes a las 10 reunión')).toBe('2026-11-02 10:00 | reunión');
    expect(said('el proximo viernes a las 9 dentista')).toBe('2026-11-06 09:00 | dentista');
  });

  it('el día de la semana con su número', () => {
    expect(said('el viernes 6 a las 10 revisión')).toBe('2026-11-06 10:00 | revisión');
    expect(said('el viernes 6 de noviembre a las 10 revisión')).toBe('2026-11-06 10:00 | revisión');
    expect(said('el lunes 9/11 a las 18 gym')).toBe('2026-11-09 18:00 | gym');
    expect(said('el lunes, 9 de noviembre a las 10 x')).toBe('2026-11-09 10:00 | x');
    // Si no cuadran (el 7 es sábado), se pregunta otra vez en vez de adivinar.
    expect(said('el viernes 7 a las 10 revisión')).toBeNull();
  });

  it('«esta mañana / tarde / noche a las …» es hoy', () => {
    expect(said('esta tarde a las 5 café')).toBe('2026-11-01 17:00 | café');
    expect(said('esta noche a las 10 cena')).toBe('2026-11-01 22:00 | cena');
    expect(said('esta noche a la una y media vuelta')).toBe('2026-11-02 01:30 | vuelta');
    expect(said('esta tarde a las seis y media cine')).toBe('2026-11-01 18:30 | cine');
  });

  it('«a la una y media de la noche» es la 01:30 de esa noche', () => {
    expect(said('el viernes a la una y media de la noche fiesta')).toBe(
      '2026-11-07 01:30 | fiesta',
    );
  });

  it('lo de siempre sigue igual', () => {
    expect(said('el lunes 10:30 reunión')).toBe('2026-11-02 10:30 | reunión');
    expect(said('el lunes que viene a las 10 reunión')).toBe('2026-11-02 10:00 | reunión');
    expect(said('el 6 a las 10 revisión')).toBe('2026-11-06 10:00 | revisión');
    expect(said('mañana a la una y media comida')).toBe('2026-11-02 13:30 | comida');
  });
});
