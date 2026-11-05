import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// bugs29 (pista de agente-2): /calendario «hoy a las 5 dentista» dicho a las 10 quedaba a las
// 5:00, que ya había pasado, y preguntaba «¿Lo apunto igualmente?». Ahora son las 17:00, como
// los recordatorios (#2044).
describe('/calendario «hoy a las 5» por la mañana (bugs29)', () => {
  const TZ = 'Europe/Madrid';
  const at10 = new Date('2026-11-05T09:00:00Z'); // 10:00 en Madrid
  const madrid = (d: Date | undefined): string =>
    d ? d.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16) : 'null';
  const start = (text: string, now = at10): string =>
    madrid(parseFechaCalendario(text, now, TZ)?.start);

  it('la hora que ya pasó hoy es la de la tarde', () => {
    expect(start('hoy a las 5 dentista')).toBe('2026-11-05 17:00');
    expect(start('hoy a las 9:30 llamar a Ana')).toBe('2026-11-05 21:30');
    expect(parseFechaCalendario('hoy a las 5 dentista', at10, TZ)?.title).toBe('dentista');
  });

  it('lo que no cambia', () => {
    expect(start('hoy a las 11 reunión')).toBe('2026-11-05 11:00'); // aún no ha llegado
    expect(start('hoy a las 5 de la mañana correr')).toBe('2026-11-05 05:00'); // lo dice
    expect(start('hoy a las 05:00 correr')).toBe('2026-11-05 05:00'); // 24 h
    expect(start('mañana a las 5 dentista')).toBe('2026-11-06 05:00'); // otro día
    const at18 = new Date('2026-11-05T17:30:00Z'); // 18:30: las dos han pasado
    expect(start('hoy a las 5 dentista', at18)).toBe('2026-11-05 05:00');
  });
});
