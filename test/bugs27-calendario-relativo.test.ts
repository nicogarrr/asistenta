import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

const TZ = 'Europe/Madrid';
const now = new Date('2026-11-03T10:00:20+01:00');
const at = (t: string) => {
  const r = parseFechaCalendario(t, now, TZ);
  return r ? [r.start.toISOString(), r.title] : null;
};

describe('/calendario: «en 2 horas», «dentro de media hora», «dentro de 2 semanas a las 9»', () => {
  it('minutos y horas cuentan desde ahora', () => {
    expect(at('en 2 horas dentista')).toEqual(['2026-11-03T11:00:00.000Z', 'dentista']);
    expect(at('dentro de media hora llamar a Ana')).toEqual([
      '2026-11-03T09:30:00.000Z',
      'llamar a Ana',
    ]);
    expect(at('en 20 minutos sacar la ropa')).toEqual([
      '2026-11-03T09:20:00.000Z',
      'sacar la ropa',
    ]);
    expect(at('dentro de una hora y media recoger a Lucía')).toEqual([
      '2026-11-03T10:30:00.000Z',
      'recoger a Lucía',
    ]);
  });

  it('días y semanas con la hora detrás', () => {
    expect(at('dentro de 2 semanas a las 9 revisión')).toEqual([
      '2026-11-17T08:00:00.000Z',
      'revisión',
    ]);
    expect(at('en 3 días a las 18:30 ITV del coche')).toEqual([
      '2026-11-06T17:30:00.000Z',
      'ITV del coche',
    ]);
  });

  it('lo que no cuadra se sigue preguntando', () => {
    expect(at('en 2 horas')).toBeNull();
    expect(at('dentro de 3 días dentista')).toBeNull();
    expect(at('en 2 horas a las 9 x')).toBeNull();
  });

  it('lo de siempre no cambia', () => {
    expect(at('mañana a las 18:00 dentista')).toEqual(['2026-11-04T17:00:00.000Z', 'dentista']);
    expect(at('entrega del coche')).toBeNull();
  });
});
