import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

const said = (text: string): string | null => {
  const parsed = parseNatural(text);
  return parsed ? scheduleEs(parsed.schedule) : null;
};

describe('franja de un intervalo dicha con horas reales (bugs13)', () => {
  it('lo que acaba a medianoche dice «a 00:00», no «a 24:00»', () => {
    expect(said('cada 30 min a partir de las 16')).toBe('cada 30 min de 16:00 a 00:00');
    expect(scheduleEs('*/15 22-23 * * *')).toBe('cada 15 min de 22:00 a 00:00');
  });

  it('con paso de horas, la franja acaba en la última vez que suena', () => {
    expect(said('cada 2 horas desde las 8')).toBe('cada 2 horas de 08:00 a 22:00');
    expect(scheduleEs('0 9-18/4 * * *')).toBe('cada 4 horas de 09:00 a 17:00');
  });

  it('lo que ya se decía bien sigue igual', () => {
    expect(said('cada 30 min de 16 a 23')).toBe('cada 30 min de 16:00 a 23:00');
    expect(scheduleEs('0 8-20/2 * * *')).toBe('cada 2 horas de 08:00 a 20:00');
    expect(said('cada hora a partir de las 16')).toBe('cada hora de 16:00 a 23:00');
  });
});
