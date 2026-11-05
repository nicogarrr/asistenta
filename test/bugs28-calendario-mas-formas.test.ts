import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// bugs28: /calendario (y los recordatorios con las palabras de Nico) no entendían el título
// delante («dentista mañana a las 9»), «a las 9 h 15», y «a las 9 y 15» quedaba a las 9:00
// con el título «y 15 médico».
const TZ = 'Europe/Madrid';
const now = new Date('2026-11-05T09:00:00+01:00'); // jueves
const hora = (t: string) => {
  const r = parseFechaCalendario(t, now, TZ);
  return r
    ? `${r.start.toLocaleString('es-ES', { timeZone: TZ, day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })} | ${r.title}`
    : null;
};

describe('/calendario: más formas de decir la fecha', () => {
  it('«a las 9 y 15», «a las 10 y diez», «a las 6 menos 10»: los minutos cuentan', () => {
    expect(hora('mañana a las 9 y 15 médico')).toBe('6/11, 09:15 | médico');
    expect(hora('mañana a las 10 y diez café')).toBe('6/11, 10:10 | café');
    expect(hora('mañana a las 6 menos 10 de la tarde tren')).toBe('6/11, 17:50 | tren');
  });

  it('«a las 9 h 15» y «a las 9h15»', () => {
    expect(hora('mañana a las 9 h 15 dentista')).toBe('6/11, 09:15 | dentista');
    expect(hora('mañana a las 9h15 dentista')).toBe('6/11, 09:15 | dentista');
  });

  it('el título delante de la fecha', () => {
    expect(hora('dentista mañana a las 9')).toBe('6/11, 09:00 | dentista');
    expect(hora('cena con Ana el viernes a las 21:30')).toBe('6/11, 21:30 | cena con Ana');
    expect(hora('comida con Ana mañana a mediodía')).toBe('6/11, 12:00 | comida con Ana');
    expect(hora('ITV el 12/11 a las 8:30')).toBe('12/11, 08:30 | ITV');
    expect(hora('llamar a Ana en 2 horas')).toBe('5/11, 11:00 | llamar a Ana');
    expect(hora('cena esta noche a las 10')).toBe('5/11, 22:00 | cena');
    expect(hora('apunta dentista mañana a las 9 y 15')).toBe('6/11, 09:15 | dentista');
  });

  it('sigue preguntando cuando no está claro', () => {
    expect(hora('reunión mañana a las 9 30')).toBeNull();
    expect(hora('a las 17:00 reunión')).toBeNull();
    expect(hora('dentista')).toBeNull();
    expect(hora('el viernes 7 a las 10 cena')).toBeNull(); // el viernes es 6
    expect(hora('reunión con el 7 de copas')).toBeNull();
  });

  it('lo de siempre no cambia', () => {
    expect(hora('mañana a las 9 dentista')).toBe('6/11, 09:00 | dentista');
    expect(hora('mañana a las 9 y media dentista')).toBe('6/11, 09:30 | dentista');
    expect(hora('mañana a mediodía comida')).toBe('6/11, 12:00 | comida');
  });
});
