import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/** «a las 8:00 y 20:00» sonaba a las 8:20 (el «20» se leía como minutos de las 8). */
const sched = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: dos horas con minutos escritos', () => {
  it('8:00 y 20:00 son dos tomas', () => {
    expect(sched('cada día a las 8:00 y 20:00 pastilla')).toBe('0 8,20 * * *');
    expect(sched('cada día a las 8:30 y 20:30 pastilla')).toBe('30 8,20 * * *');
  });
  it('minutos distintos se preguntan', () => {
    expect(sched('cada día a las 8:00 y 20:30 pastilla')).toBeNull();
  });
  it('lo de siempre sigue igual', () => {
    expect(sched('cada día a las 10 y 20 pastilla')).toBe('20 10 * * *');
    expect(sched('cada día a las 8 y media pastilla')).toBe('30 8 * * *');
    expect(sched('cada día a las 8:30 pastilla')).toBe('30 8 * * *');
  });
});
