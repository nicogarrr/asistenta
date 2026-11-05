import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// Dictado por voz: el número sale en letra («en cuarenta y cinco minutos»), y antes
// solo se entendían unos pocos (cinco, diez, quince, veinte, treinta…).
describe('fecha relativa con el número en letra', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const min = (t: string) => {
    const r = parseFechaCalendario(t, now, 'Europe/Madrid');
    return r ? Math.round((r.start.getTime() - now.getTime()) / 60000) : null;
  };
  it.each([
    ['en cuarenta y cinco minutos llamar a Ana', 45],
    ['en doce minutos sacar el pan', 12],
    ['dentro de cuarenta minutos reunión', 40],
    ['en un par de horas recoger el paquete', 120],
    ['en dieciocho minutos apagar el horno', 18],
  ])('%s', (t, m) => {
    expect(min(t)).toBe(m);
  });
  it('el título no se come la palabra del número', () => {
    expect(
      parseFechaCalendario('en cuarenta y cinco minutos llamar a Ana', now, 'Europe/Madrid')?.title,
    ).toBe('llamar a Ana');
  });
});
