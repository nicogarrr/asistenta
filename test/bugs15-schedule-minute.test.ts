import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';

describe('«cada 2 horas» dice el minuto cuando no es en punto', () => {
  it('«15 */2 * * *» suena a y cuarto: lo dice', () => {
    expect(scheduleEs('15 */2 * * *')).toBe('cada 2 horas, a los 15 min');
  });

  it('con días también', () => {
    expect(scheduleEs('15 * * * 1-5')).toBe('cada hora, a los 15 min, de lunes a viernes');
    expect(scheduleEs('30 */3 * * 1-5')).toBe('cada 3 horas, a los 30 min, de lunes a viernes');
  });

  it('en punto sigue igual', () => {
    expect(scheduleEs('0 */2 * * *')).toBe('cada 2 horas');
    expect(scheduleEs('0 * * * *')).toBe('cada hora, en punto');
    expect(scheduleEs('15 * * * *')).toBe('cada hora, a los 15 min');
  });
});
