import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

const TZ = 'Europe/Madrid';
const now = new Date('2026-11-01T10:00:00+01:00');
const at = (text: string) => parseFechaCalendario(text, now, TZ)?.start.toISOString() ?? null;

describe('/calendario: «a las 12 de la noche» es medianoche, no mediodía', () => {
  it('«el viernes a las 12 de la noche» es la medianoche al acabar el viernes', () => {
    // Viernes 6 de noviembre; las 00:00 del sábado 7 en Madrid son las 23:00 UTC del 6.
    expect(at('el viernes a las 12 de la noche fiesta')).toBe('2026-11-06T23:00:00.000Z');
  });

  it('«a las 12 de la madrugada» es las 00:00 de ese mismo día', () => {
    expect(at('el 5 a las 12 de la madrugada guardia')).toBe('2026-11-04T23:00:00.000Z');
  });

  it('el mediodía y las demás horas no cambian', () => {
    expect(at('hoy a las 12 de la mañana dentista')).toBe('2026-11-01T11:00:00.000Z');
    expect(at('mañana a las 12 comida')).toBe('2026-11-02T11:00:00.000Z');
    expect(at('mañana a las 11 de la noche cena')).toBe('2026-11-02T22:00:00.000Z');
  });
});
