import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// bugs30: /calendario con la hora detrás del título («el lunes reunión con Ana a las 9:30»)
// contestaba «No he pillado la fecha o la hora».
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-05T10:15:00+01:00'); // jueves
const at = (iso: string) => new Date(iso).toISOString();
const read = (s: string) => {
  const r = parseFechaCalendario(s, NOW, TZ);
  return r ? { start: r.start.toISOString(), title: r.title } : null;
};

describe('/calendario con la hora detrás del título (bugs30)', () => {
  it('«el lunes reunión con Ana a las 9:30»', () => {
    expect(read('el lunes reunión con Ana a las 9:30')).toEqual({
      start: at('2026-11-09T09:30:00+01:00'),
      title: 'reunión con Ana',
    });
  });
  it('«pasado mañana comida con Luis a las 14» y «mañana dentista a las 5 de la tarde»', () => {
    expect(read('pasado mañana comida con Luis a las 14')).toEqual({
      start: at('2026-11-07T14:00:00+01:00'),
      title: 'comida con Luis',
    });
    expect(read('mañana dentista a las 5 de la tarde')).toEqual({
      start: at('2026-11-06T17:00:00+01:00'),
      title: 'dentista',
    });
  });
  it('la hora en medio del título y una fecha con mes', () => {
    expect(read('el lunes reunión a las 9 con Ana')).toEqual({
      start: at('2026-11-09T09:00:00+01:00'),
      title: 'reunión con Ana',
    });
    expect(read('apunta el 12 de diciembre cumple de mamá a las 18')).toEqual({
      start: at('2026-12-12T18:00:00+01:00'),
      title: 'cumple de mamá',
    });
  });
  it('lo dudoso se sigue preguntando: tramos, número de día suelto, sin hora', () => {
    expect(read('el lunes de 9 a 11:30 curso')).toBeNull();
    expect(read('el lunes 9 dentista a las 10')).toBeNull();
    expect(read('mañana comprar pan')).toBeNull();
    expect(read('mañana el dentista a las')).toBeNull();
  });
  it('lo de siempre no cambia', () => {
    expect(read('mañana a las 10 dentista')).toEqual({
      start: at('2026-11-06T10:00:00+01:00'),
      title: 'dentista',
    });
    expect(read('dentista mañana a las 10')).toEqual({
      start: at('2026-11-06T10:00:00+01:00'),
      title: 'dentista',
    });
  });
});
