import { describe, expect, it } from 'vitest';
import { respuestaCalendarioPasado } from '../src/agenda/calendario-respuesta.js';

// bugs28: a «¿Lo apunto igualmente? Dime «sí», o dime otra fecha.» la otra fecha solo valía
// repitiendo el título; «mañana a las 10» o «no, mejor el viernes a las 10» caían al modelo.
const TZ = 'Europe/Madrid';
const now = new Date('2026-11-05T12:00:00+01:00'); // jueves
const start = new Date('2026-11-05T10:00:00+01:00');
const r = (t: string) => respuestaCalendarioPasado(t, start, 'dentista', now, TZ);

describe('/calendario: responder con otra fecha a «¿Lo apunto igualmente?»', () => {
  it('solo la fecha: el mismo evento en la fecha nueva', () => {
    expect(r('mañana a las 10')).toBe('add mañana a las 10 dentista');
    expect(r('no, mejor el viernes a las 10')).toBe('add el viernes a las 10 dentista');
    expect(r('pues mañana a las 9 y media')).toBe('add mañana a las 9 y media dentista');
  });

  it('la fecha con su título sigue valiendo como antes', () => {
    expect(r('mañana a las 10 cena')).toBe('add mañana a las 10 cena');
  });

  it('un sí confirma la fecha pasada', () => {
    expect(r('sí')).toBe(`confirmado ${start.toISOString()} | dentista`);
  });

  it('lo que no es ni sí ni fecha lo lee el modelo', () => {
    expect(r('no')).toBeNull();
    expect(r('¿qué tengo mañana?')).toBeNull();
    expect(r('déjalo')).toBeNull();
  });
});
