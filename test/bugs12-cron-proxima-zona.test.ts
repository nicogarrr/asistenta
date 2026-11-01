import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatNextRun } from '../src/daemon/cron-command.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/cron: la próxima vez en la hora de PA_TIMEZONE (bugs12)', () => {
  it('con el proceso en UTC y PA_TIMEZONE=Europe/Madrid enseña la hora de Madrid', () => {
    vi.stubEnv('TZ', 'UTC');
    vi.stubEnv('PA_TIMEZONE', 'Europe/Madrid');
    const now = Date.UTC(2026, 10, 3, 8, 0);
    // La rutina «0 21 * * *» dispara a las 21:00 de Madrid = 20:00 UTC.
    expect(formatNextRun(Date.UTC(2026, 10, 3, 20, 0), now)).toMatch(/^2026-11-03 21:00 /);
    // Pasada la medianoche de Madrid (23:30 UTC = 00:30 del día 4) ya es otro día.
    expect(formatNextRun(Date.UTC(2026, 10, 3, 23, 30), now)).toMatch(/^2026-11-04 00:30 /);
  });
});
