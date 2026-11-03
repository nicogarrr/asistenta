import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

/**
 * /calendario: «mañana al mediodía comida» contestaba «No he pillado la fecha» (solo valía
 * «a mediodía»), «a las doce del mediodía comida» se apuntaba con el título «del mediodía
 * comida» y «a las 9 en punto bus» con el título «en punto bus».
 */
const now = new Date('2026-11-03T10:00:00+01:00');
const at = (text: string) => {
  const r = parseFechaCalendario(text, now, 'Europe/Madrid');
  return r
    ? `${r.start.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} | ${r.title}`
    : null;
};

describe('/calendario: mediodía y «en punto»', () => {
  it('«al mediodía» y «a las doce del mediodía» son las 12:00 sin ensuciar el título', () => {
    expect(at('mañana al mediodía comida')).toBe('4/11/2026, 12:00:00 | comida');
    expect(at('el viernes al mediodía comida con Ana')).toBe(
      '6/11/2026, 12:00:00 | comida con Ana',
    );
    expect(at('mañana a las doce del mediodía comida')).toBe('4/11/2026, 12:00:00 | comida');
    expect(at('mañana a las 12 del mediodía comida')).toBe('4/11/2026, 12:00:00 | comida');
  });

  it('«en punto» no va al título', () => {
    expect(at('mañana a las 9 en punto bus')).toBe('4/11/2026, 9:00:00 | bus');
    expect(at('mañana a las nueve en punto de la noche cine')).toBe('4/11/2026, 21:00:00 | cine');
    expect(at('el lunes a las 10:30 en punto reunión')).toBe('9/11/2026, 10:30:00 | reunión');
  });

  it('lo de siempre no cambia', () => {
    expect(at('mañana a mediodía comida')).toBe('4/11/2026, 12:00:00 | comida');
    // Con otra hora dicha antes, «mediodía» es parte del título.
    expect(at('mañana a las 14 comida al mediodía con Ana')).toBe(
      '4/11/2026, 14:00:00 | comida al mediodía con Ana',
    );
    expect(at('mañana a las 9 y media médico')).toBe('4/11/2026, 9:30:00 | médico');
    expect(at('mañana a las 18:00 punto de encuentro')).toBe(
      '4/11/2026, 18:00:00 | punto de encuentro',
    );
  });
});
