import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

/**
 * /calendario con los minutos separados de la hora: «mañana a las 21 30 cena» quedaba a
 * las 21:00 con el título «30 cena», y «a las 9 h 30» igual. Ahora se pregunta otra vez
 * (null) en vez de apuntar otra hora.
 */
const now = new Date('2026-11-02T10:00:00+01:00'); // lunes 2 de noviembre
const when = (text: string): string | null => {
  const r = parseFechaCalendario(text, now, 'Europe/Madrid');
  return r
    ? `${r.start.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })} | ${r.title}`
    : null;
};

describe('/calendario: minutos sueltos tras la hora', () => {
  it.each(['mañana a las 21 30 cena', 'el viernes a las 8 45 dentista'])(
    '«%s» pregunta en vez de apuntarlo a la hora en punto',
    (text) => {
      expect(when(text)).toBeNull();
    },
  );

  // bugs28: «a las 9 h 30» se lee ya bien (9:30), así que se apunta en vez de preguntar.
  it.each(['mañana a las 9 h 30 cena', 'mañana a las 9h 30 cena'])(
    '«%s» queda a las 9:30',
    (text) => {
      expect(when(text)).toMatch(/9:30 \| cena$/);
    },
  );

  it('lo que ya iba bien no cambia', () => {
    expect(when('mañana a las 21:30 cena')).toBe('3/11/26, 21:30 | cena');
    expect(when('mañana a las 9 cena')).toBe('3/11/26, 9:00 | cena');
    expect(when('mañana a las 10 2ª revisión')).toBe('3/11/26, 10:00 | 2ª revisión');
    expect(when('mañana a las 10 100 metros')).toBe('3/11/26, 10:00 | 100 metros');
    expect(when('mañana a las 9 de la noche 30 aniversario')).toBe(
      '3/11/26, 21:00 | 30 aniversario',
    );
    expect(when('mañana a las 8 pm 30 aniversario')).toBe('3/11/26, 20:00 | 30 aniversario');
  });
});
