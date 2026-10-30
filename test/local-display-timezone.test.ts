import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRoutineOutput } from '../src/routine-delivery.js';
import { fechaCortaEs } from '../src/tools/reminder.js';

// Con el proceso en UTC y PA_TIMEZONE=Europe/Madrid, las 23:30 UTC del viernes
// son las 00:30 del sábado para Nico: lo que se le enseña y el fichero del día
// de una rutina deben ir en su zona.
describe('fechas que ve Nico en PA_TIMEZONE', () => {
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

  it('/recordatorios muestra «sáb 31/10 00:30»', () => {
    expect(fechaCortaEs(new Date('2026-10-30T23:30:00Z'))).toBe('sáb 31/10 00:30');
  });

  it('la salida de rutina va al fichero del sábado con la hora 00:30', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-out-'));
    const file = writeRoutineOutput(dir, 'resumen', 'hola', new Date('2026-10-30T23:30:00Z'));
    expect(file.endsWith('2026-10-31.md')).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('## 00:30');
  });
});
