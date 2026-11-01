import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

const TZ = 'Europe/Madrid';
const now = new Date('2026-11-01T10:00:00+01:00');
const at = (text: string) => parseFechaCalendario(text, now, TZ)?.start.toISOString() ?? null;

describe('/calendario: «el 15-11» con guion y «el 31» en un mes de 30 días', () => {
  it('«el 15-11 a las 10» es el 15 de noviembre, como «15/11»', () => {
    expect(at('el 15-11 a las 10 dentista')).toBe('2026-11-15T09:00:00.000Z');
    expect(at('15-11-2026 a las 10 dentista')).toBe('2026-11-15T09:00:00.000Z');
    expect(at('el 15/11 a las 10 dentista')).toBe('2026-11-15T09:00:00.000Z');
  });

  it('«el 31» dicho en noviembre va al 31 de diciembre en vez de volver a preguntar', () => {
    expect(at('el 31 a las 10 cena')).toBe('2026-12-31T09:00:00.000Z');
  });

  it('las fechas imposibles siguen sin valer', () => {
    expect(at('el 31-11 a las 10 x')).toBeNull();
    expect(at('el 32 a las 10 x')).toBeNull();
  });
});
