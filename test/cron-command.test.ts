import { describe, expect, it } from 'vitest';
import { parseCronAdd } from '../src/cron/scheduler.js';
import { validateSchedule } from '../src/routines.js';

describe('parseCronAdd', () => {
  it('literal schedule|prompt parses and validates', () => {
    const r = parseCronAdd('0 8 * * * | resumen del día', validateSchedule);
    expect(r).toMatchObject({ ok: true, schedule: '0 8 * * *', prompt: 'resumen del día' });
  });
  it('missing prompt after the pipe is an error, not a throw', () => {
    expect(parseCronAdd('0 8 * * * |', validateSchedule).ok).toBe(false);
  });
  it('missing schedule before the pipe is an error, not a throw', () => {
    expect(parseCronAdd('| tarea', validateSchedule).ok).toBe(false);
  });
  it('an invalid literal schedule is rejected with the validator error', () => {
    const r = parseCronAdd('no-es-cron | tarea', validateSchedule);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('horario');
  });
  it('a literal schedule that never fires is rejected', () => {
    expect(parseCronAdd('0 0 30 2 * | tarea', validateSchedule).ok).toBe(false);
  });
  it('six-field with seconds works', () => {
    expect(parseCronAdd('0 0 8 * * * | tarea', validateSchedule).ok).toBe(true);
  });
  it('natural language falls back to parseNatural', () => {
    const r = parseCronAdd('cada mañana a las 8 un resumen de mi día', validateSchedule);
    expect(r).toMatchObject({ ok: true, schedule: '0 8 * * *' });
  });
  it('unparseable natural text is an error, not a throw', () => {
    expect(parseCronAdd('cuando puedas gracias', validateSchedule).ok).toBe(false);
  });
});
