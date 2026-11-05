import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/**
 * Rutinas: una hora con minutos escritos vale sin «a las». «9:00 todos los días» sonaba a
 * las 8:00 y «todos los días 9:00» o «cada día 21:15» se leían como el día 9 o 21 del mes.
 */
const sched = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: hora con minutos sin «a las»', () => {
  it('la hora vale', () => {
    expect(sched('9:00 todos los días')).toBe('0 9 * * *');
    expect(sched('cada lunes 18:30 inglés')).toBe('30 18 * * 1');
    expect(sched('de lunes a viernes 8:15 gimnasio')).toBe('15 8 * * 1-5');
  });
  it('no se lee como día del mes', () => {
    expect(sched('todos los días 9:00')).toBe('0 9 * * *');
    expect(sched('cada día 21:15 pastilla')).toBe('15 21 * * *');
    expect(sched('cada día 9:00 y 21:00 pastilla')).toBe('0 9,21 * * *');
  });
  it('los días del mes de verdad siguen igual', () => {
    expect(sched('cada día 15 a las 10')).toBe('0 10 15 * *');
    expect(sched('todos los días 15 pastilla')).toBe('0 8 15 * *');
    expect(sched('cada día a las 9 reunión de las 10:30')).toBe('0 9 * * *');
  });
});
