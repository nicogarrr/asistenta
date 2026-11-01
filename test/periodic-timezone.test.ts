// Proceso en UTC (servidor, CI) y PA_TIMEZONE=Europe/Madrid: las tareas de
// «domingo desde las 18:00» o «desde las 03:00» tienen que mirar la hora de
// Nico, no la del reloj del proceso.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBackupDue } from '../src/backup.js';
import { isEvolveDue } from '../src/evolve/run.js';
import { isConsolidationDue } from '../src/memory/consolidate.js';
import { isWeeklyDue } from '../src/weekly.js';

const LONG_AGO = 0;

describe('tareas periódicas en PA_TIMEZONE', () => {
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

  it('resumen semanal: domingo 18:30 en Madrid (17:30 UTC) ya toca', () => {
    expect(isWeeklyDue(new Date('2026-11-01T17:30:00Z'), LONG_AGO)).toBe(true);
  });
  it('resumen semanal: domingo 17:30 en Madrid (16:30 UTC) aún no', () => {
    expect(isWeeklyDue(new Date('2026-11-01T16:30:00Z'), LONG_AGO)).toBe(false);
  });
  it('resumen semanal: lunes 00:30 en Madrid (domingo 23:30 UTC) ya no es domingo', () => {
    expect(isWeeklyDue(new Date('2026-11-01T23:30:00Z'), LONG_AGO)).toBe(false);
  });
  it('evolución: domingo 03:30 en Madrid (02:30 UTC) toca', () => {
    expect(isEvolveDue(new Date('2026-11-01T02:30:00Z'), LONG_AGO)).toBe(true);
  });
  it('copia y consolidación: 03:30 en Madrid (02:30 UTC) tocan', () => {
    const now = new Date('2026-11-03T02:30:00Z');
    expect(isBackupDue(now, LONG_AGO)).toBe(true);
    expect(isConsolidationDue(now, LONG_AGO)).toBe(true);
  });
  it('copia y consolidación: 02:30 en Madrid (01:30 UTC) aún no', () => {
    const now = new Date('2026-11-03T01:30:00Z');
    expect(isBackupDue(now, LONG_AGO)).toBe(false);
    expect(isConsolidationDue(now, LONG_AGO)).toBe(false);
  });
});
