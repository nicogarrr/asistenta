import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

describe('horario en palabras con varias tomas al día', () => {
  it('«a las 9 y a las 21» se dice con las dos horas', () => {
    // Antes: null, y la lista de recordatorios ponía «se repite con un horario propio».
    expect(scheduleEs('0 9,21 * * *')).toBe('cada día a las 09:00 y 21:00');
    expect(scheduleEs('0 8,14,20 * * *')).toBe('cada día a las 08:00, 14:00 y 20:00');
    expect(scheduleEs('30 8,20 * * 1-5')).toBe('de lunes a viernes a las 08:30 y 20:30');
    expect(scheduleEs('0 9,18 * * 1')).toBe('cada lunes a las 09:00 y 18:00');
    expect(scheduleEs('0 9,21 5 * *')).toBe('cada mes el día 5 a las 09:00 y 21:00');
  });

  it('lo que sale de una frase de rutina se puede decir', () => {
    const cron = parseNatural('cada día a las 9 y a las 21 pastilla')?.schedule ?? '';
    expect(scheduleEs(cron)).toBe('cada día a las 09:00 y 21:00');
  });

  it('lo de siempre sigue igual', () => {
    expect(scheduleEs('0 9 * * *')).toBe('cada día a las 09:00');
    expect(scheduleEs('0 */2 * * *')).toBe('cada 2 horas');
    expect(scheduleEs('*/15 * * * *')).toBe('cada 15 min');
    expect(scheduleEs('0 9,25 * * *')).toBeNull();
  });
});
