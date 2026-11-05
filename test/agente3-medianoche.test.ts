import { describe, expect, it } from 'vitest';
import { medianocheDe, whenFromWords } from '../src/tools/reminder.js';

/**
 * «El sábado a medianoche» no se entendía (solo «a medianoche» sin día). La medianoche de
 * un día es el 0:00 de la noche siguiente.
 */
const TZ = 'Europe/Madrid';
const JUEVES = new Date('2026-11-05T10:00:00+01:00');
const local = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat('es-ES', {
        weekday: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: TZ,
      }).format(d)
    : null;

describe('medianoche con día', () => {
  it.each([
    ['el sábado a medianoche', 'domingo 8, 00:00'],
    ['el sabado a medianoche', 'domingo 8, 00:00'],
    ['el viernes a medianoche', 'sábado 7, 00:00'],
    ['mañana a medianoche', 'sábado 7, 00:00'],
    ['hoy a medianoche', 'viernes 6, 00:00'],
    ['esta noche a medianoche', 'viernes 6, 00:00'],
    ['el jueves a medianoche', 'viernes 6, 00:00'],
    ['el próximo jueves a medianoche', 'viernes 13, 00:00'],
    ['el miércoles a medianoche', 'jueves 12, 00:00'],
    ['pasado mañana a medianoche', 'domingo 8, 00:00'],
  ])('%s → %s', (said, want) => {
    expect(local(whenFromWords(said, JUEVES, TZ))).toBe(want);
  });

  it('sin día sigue como antes y lo demás no se toca', () => {
    expect(local(whenFromWords('a medianoche', JUEVES, TZ))).toBe('viernes 6, 00:00');
    expect(medianocheDe('el sábado a las 9', JUEVES, TZ)).toBeNull();
    expect(medianocheDe('medianoche', JUEVES, TZ)).toBeNull();
  });
});
