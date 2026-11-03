import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

/**
 * /calendario: «mañana por la tarde a las 5 café» o «el viernes por la noche a las 9 cine»
 * contestaban «No he pillado la fecha»: la parte del día solo valía detrás de la hora
 * («a las 5 de la tarde»).
 */
const now = new Date('2026-11-03T10:00:00+01:00');
const at = (text: string) => {
  const r = parseFechaCalendario(text, now, 'Europe/Madrid');
  return r
    ? `${r.start.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} | ${r.title}`
    : null;
};

describe('/calendario: «por la tarde a las 5»', () => {
  it('la parte del día delante de la hora', () => {
    expect(at('mañana por la tarde a las 5 café')).toBe('4/11/2026, 17:00:00 | café');
    expect(at('el viernes por la noche a las 9 cine')).toBe('6/11/2026, 21:00:00 | cine');
    expect(at('mañana por la mañana a las 9 dentista')).toBe('4/11/2026, 9:00:00 | dentista');
    expect(at('mañana por la tarde, a las cinco y media, café con Ana')).toBe(
      '4/11/2026, 17:30:00 | café con Ana',
    );
    expect(at('el 10 de diciembre por la tarde a las 6:15 tutoría')).toBe(
      '10/12/2026, 18:15:00 | tutoría',
    );
  });

  it('sin hora sigue preguntando, y «a la una» no se toca', () => {
    expect(at('el sábado por la mañana mercado')).toBeNull();
    expect(at('mañana por la noche a la una fiesta')).toBeNull();
    expect(at('mañana a las 5 de la tarde café')).toBe('4/11/2026, 17:00:00 | café');
  });
});
