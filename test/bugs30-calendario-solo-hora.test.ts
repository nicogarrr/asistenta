import { describe, expect, it } from 'vitest';
import { respuestaCalendarioPasado } from '../src/agenda/calendario-respuesta.js';
import { parseFechaCalendario, parseFechaCalendarioDicha } from '../src/agenda/fecha-natural.js';

// bugs30: /calendario «a las 18 llamada con Juan» (sin día) contestaba «No he pillado la
// fecha o la hora». Ahora es hoy si aún no ha pasado y, si no, mañana.
const TZ = 'Europe/Madrid';
const at = (iso: string) => new Date(iso).toISOString();
const read = (s: string, now: string) => {
  const r = parseFechaCalendarioDicha(s, new Date(now), TZ);
  return r ? { start: r.start.toISOString(), title: r.title } : null;
};

describe('/calendario con solo la hora (bugs30)', () => {
  it('por la mañana «a las 18 llamada con Juan» es hoy a las 18:00', () => {
    expect(read('a las 18 llamada con Juan', '2026-11-05T10:15:00+01:00')).toEqual({
      start: at('2026-11-05T18:00:00+01:00'),
      title: 'llamada con Juan',
    });
  });
  it('si ya pasó hoy, mañana («a las 08:30 dentista» a las 21:00)', () => {
    expect(read('a las 08:30 dentista', '2026-11-05T21:00:00+01:00')).toEqual({
      start: at('2026-11-06T08:30:00+01:00'),
      title: 'dentista',
    });
    // «a las 9:30» a las 21:00 es la próxima de las dos lecturas (21:30), como los recordatorios.
    expect(read('a las 9:30 dentista', '2026-11-05T21:00:00+01:00')?.start).toBe(
      at('2026-11-05T21:30:00+01:00'),
    );
  });
  it('«a las 5 dentista» por la mañana: las 17:00 de hoy, como «hoy a las 5»', () => {
    expect(read('a las 5 dentista', '2026-11-05T10:15:00+01:00')).toEqual({
      start: at('2026-11-05T17:00:00+01:00'),
      title: 'dentista',
    });
  });
  it('con día, lo de siempre; sin hora, se sigue preguntando', () => {
    expect(read('mañana a las 10 dentista', '2026-11-05T10:15:00+01:00')?.start).toBe(
      at('2026-11-06T10:00:00+01:00'),
    );
    expect(read('dentista', '2026-11-05T10:15:00+01:00')).toBeNull();
    expect(read('a las', '2026-11-05T10:15:00+01:00')).toBeNull();
    // El lector de fechas de los recordatorios no cambia: sin día sigue siendo null ahí.
    expect(
      parseFechaCalendario('a las 18 recordatorio', new Date('2026-11-05T10:15:00+01:00'), TZ),
    ).toBeNull();
  });
  it('a «¿Lo apunto igualmente?» vale contestar solo «a las 10»', () => {
    const start = new Date('2026-11-05T09:00:00+01:00');
    expect(
      respuestaCalendarioPasado(
        'no, a las 19',
        start,
        'dentista',
        new Date('2026-11-05T10:15:00+01:00'),
        TZ,
      ),
    ).toBe('add a las 19 dentista');
  });
});
