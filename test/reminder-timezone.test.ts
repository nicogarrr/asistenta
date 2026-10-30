import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onceCron, parseLocalStamp } from '../src/tools/reminder.js';

// croner dispara en PA_TIMEZONE (#485). El recordatorio puntual debe leer la hora
// y escribir su cron en esa misma zona aunque el proceso esté en UTC; si no,
// «en 30 minutos» o «a las 9» saltaban una hora tarde.
describe('recordatorio puntual en PA_TIMEZONE con el proceso en UTC', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
  });
  afterEach(() => {
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  it('«2026-11-02T09:00» son las 9 de Madrid (08:00 UTC) y su cron dice 9', () => {
    const at = parseLocalStamp('2026-11-02T09:00');
    expect(at?.toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(onceCron(at as Date)).toBe('0 9 2 11 *');
  });

  it('«en 30 minutos» a las 13:40 UTC es el cron de las 14:10 de Madrid', () => {
    expect(onceCron(new Date('2026-10-30T13:40:00Z'))).toBe('40 14 30 10 *');
  });

  it('en verano son dos horas y las fechas imposibles se rechazan', () => {
    expect(parseLocalStamp('2026-07-01T09:00')?.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(parseLocalStamp('2026-02-31T09:00')).toBeNull();
    // 02:30 no existe la noche del cambio a horario de verano.
    expect(parseLocalStamp('2026-03-29T02:30')).toBeNull();
  });
});
