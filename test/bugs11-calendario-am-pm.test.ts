import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

const now = new Date('2026-11-02T10:00:00+01:00'); // lunes 2 de noviembre
const when = (text: string): string | null => {
  const r = parseFechaCalendario(text, now, 'Europe/Madrid');
  return r
    ? `${r.start.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' })} | ${r.title}`
    : null;
};

describe('/calendario con «pm» y «am» (bugs11)', () => {
  it('«8 pm» es a las 20:00 y no entra en el título', () => {
    expect(when('mañana a las 8 pm cena con Ana')).toBe('3/11/26, 20:00 | cena con Ana');
    expect(when('el viernes a las 7 PM cine')).toBe('6/11/26, 19:00 | cine');
    expect(when('mañana a las 9:30 p.m. llamada')).toBe('3/11/26, 21:30 | llamada');
  });

  it('«am» se queda por la mañana y «12 am» es medianoche', () => {
    expect(when('mañana a las 9 am dentista')).toBe('3/11/26, 9:00 | dentista');
    expect(when('mañana a las 12 am copia')).toBe('3/11/26, 0:00 | copia');
  });

  it('sin «am/pm» sigue igual, también «a mi casa»', () => {
    expect(when('pasado mañana a las 20:00 cena')).toBe('4/11/26, 20:00 | cena');
    expect(when('mañana a las 8 a mi casa')).toBe('3/11/26, 8:00 | a mi casa');
  });
});
