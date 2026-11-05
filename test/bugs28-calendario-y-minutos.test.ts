import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// bugs28: «a las 10 y 10 minutos reunión» daba 10:10 pero con el título «minutos reunión».
describe('/calendario: «y 10 minutos»', () => {
  const now = new Date('2026-11-05T10:00:00+01:00');
  it('los minutos dichos con «minutos» no quedan en el título', () => {
    for (const [t, hm, title] of [
      ['mañana a las 10 y 10 minutos reunión', '10:10', 'reunión'],
      ['el lunes a las 9 y 15 minutos médico', '9:15', 'médico'],
      ['mañana a las 7 menos 10 minutos tren', '6:50', 'tren'],
    ] as const) {
      const r = parseFechaCalendario(t, now);
      expect(r, t).not.toBeNull();
      const [h, m] = hm.split(':').map(Number);
      expect(r?.start.getHours(), t).toBe(h);
      expect(r?.start.getMinutes(), t).toBe(m);
      expect(r?.title, t).toBe(title);
    }
  });
});
