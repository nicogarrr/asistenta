import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

/**
 * /calendario: «el 10 de nov a las 9 reunión» o «el 3 de sept. a las 18 cena» contestaban
 * «No he pillado la fecha»: solo valían los meses escritos enteros.
 */
const now = new Date('2026-11-03T10:00:00+01:00');
const at = (text: string) => {
  const r = parseFechaCalendario(text, now, 'Europe/Madrid');
  return r
    ? `${r.start.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} | ${r.title}`
    : null;
};

describe('/calendario: mes abreviado', () => {
  it('se entiende con y sin punto', () => {
    expect(at('el 10 de nov a las 9 reunión')).toBe('10/11/2026, 9:00:00 | reunión');
    expect(at('el 3 de sept. a las 18 cena')).toBe('3/9/2027, 18:00:00 | cena');
    expect(at('el 3 de sep a las 18 cena')).toBe('3/9/2027, 18:00:00 | cena');
    expect(at('el 15 de dic de 2026 a las 20:30 cena de empresa')).toBe(
      '15/12/2026, 20:30:00 | cena de empresa',
    );
    expect(at('el 2 de mar a las 10 ITV')).toBe('2/3/2027, 10:00:00 | ITV');
    expect(at('el 6 de ene a las 11 reyes')).toBe('6/1/2027, 11:00:00 | reyes');
  });

  it('los meses enteros siguen igual', () => {
    expect(at('el 2 de marzo a las 10 ITV')).toBe('2/3/2027, 10:00:00 | ITV');
    expect(at('el 10 de mayo a las 9 reunión')).toBe('10/5/2027, 9:00:00 | reunión');
    expect(at('el 15 de diciembre a las 18 cena')).toBe('15/12/2026, 18:00:00 | cena');
  });
});
