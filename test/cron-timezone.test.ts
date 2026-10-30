import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findMissedSlot, validateSchedule } from '../src/routines.js';

// El proceso puede arrancar con TZ=UTC (servicio, CI, `pa` lanzado por otra
// herramienta) mientras Nico vive en PA_TIMEZONE=Europe/Madrid. croner debe
// programar en la zona configurada, no en la del proceso.
describe('croner usa PA_TIMEZONE aunque el proceso esté en otra zona', () => {
  const saved = { tz: process.env.TZ, pa: process.env.PA_TIMEZONE };
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved.tz === undefined) delete process.env.TZ;
    else process.env.TZ = saved.tz;
    if (saved.pa === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = saved.pa;
  });

  it('«0 8 * * *» es a las 8:00 de Madrid (07:00 UTC en invierno)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T05:00:00Z'));
    const check = validateSchedule('0 8 * * *');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.next).toMatch(/^2026-11-02 08:00:00 UTC\+01:00 /);
  });

  it('el aviso de rutina perdida busca la franja de las 8:00 de Madrid', () => {
    const since = new Date('2026-11-02T06:00:00Z');
    const now = new Date('2026-11-02T07:30:00Z');
    const missed = findMissedSlot('0 8 * * *', since, now);
    expect(missed?.slot.toISOString()).toBe('2026-11-02T07:00:00.000Z');
  });

  it('en verano la misma rutina cae a las 06:00 UTC', () => {
    const since = new Date('2026-07-01T05:00:00Z');
    const now = new Date('2026-07-01T06:30:00Z');
    expect(findMissedSlot('0 8 * * *', since, now)?.slot.toISOString()).toBe(
      '2026-07-01T06:00:00.000Z',
    );
  });
});
