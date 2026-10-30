// «Hoy» tiene que salir en la misma zona que `<now>` (PA_TIMEZONE), aunque el proceso
// corra en otra: los subcomandos `pa …` no pasan por serveCommand.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDay, localTimeZone } from '../src/datecontext.js';

describe('localDay sigue PA_TIMEZONE', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  beforeEach(() => {
    process.env.TZ = 'UTC';
  });
  afterEach(() => {
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  it('a las 00:30 de Madrid (23:30 UTC) ya es el día siguiente', () => {
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    const at = Date.UTC(2026, 9, 30, 23, 30);
    expect(localTimeZone()).toBe('Europe/Madrid');
    expect(localDay(at)).toBe('2026-10-31');
    expect(localDay(new Date(at))).toBe('2026-10-31');
  });

  it('el día del cambio de hora (25/10) a las 00:30 locales', () => {
    process.env.PA_TIMEZONE = 'Europe/Madrid';
    // 25/10/2026 00:30 CEST = 24/10 22:30 UTC
    expect(localDay(Date.UTC(2026, 9, 24, 22, 30))).toBe('2026-10-25');
  });

  it('sin PA_TIMEZONE usa la zona del proceso', () => {
    delete process.env.PA_TIMEZONE;
    expect(localDay(Date.UTC(2026, 9, 30, 23, 30))).toBe('2026-10-30');
  });

  it('una PA_TIMEZONE inválida cae a la zona del proceso', () => {
    process.env.PA_TIMEZONE = 'Marte/Olympus';
    expect(localDay(Date.UTC(2026, 9, 30, 23, 30))).toBe('2026-10-30');
  });
});
