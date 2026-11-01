import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionLog } from '../src/audit/log.js';
import { wallDateMinute, wallHourMinute } from '../src/datecontext.js';
import type { RoutineTrigger } from '../src/db.js';
import { formatTriggerList } from '../src/triggers.js';

// Horas que lee Nico (registro de acciones, informe de diagnóstico, /disparadores):
// en PA_TIMEZONE aunque el proceso corra en UTC.
const saved = { TZ: process.env.TZ, PA: process.env.PA_TIMEZONE };
let dir = '';

beforeEach(() => {
  process.env.TZ = 'UTC';
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'wallclock-'));
});
afterEach(() => {
  vi.useRealTimers();
  if (saved.TZ === undefined) delete process.env.TZ;
  else process.env.TZ = saved.TZ;
  if (saved.PA === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = saved.PA;
  rmSync(dir, { recursive: true, force: true });
});

describe('hora de pared en PA_TIMEZONE', () => {
  it('wallHourMinute y wallDateMinute usan Madrid, no UTC', () => {
    expect(wallHourMinute(new Date('2026-11-05T08:30:00Z'))).toBe('09:30');
    expect(wallHourMinute(new Date('2026-07-05T08:30:00Z'))).toBe('10:30');
    expect(wallDateMinute(new Date('2026-11-05T23:15:00Z'))).toBe('2026-11-06 00:15');
    expect(wallHourMinute(new Date('nope'))).toBe('??:??');
    expect(wallDateMinute(new Date('nope'))).toBe('');
  });

  it('el resumen del registro de acciones enseña la hora de Madrid', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T08:30:00Z'));
    const audit = new ActionLog({ file: join(dir, 'actions.jsonl') });
    audit.record({ actor: 'agente', action: 'shell', result: 'ok' } as Parameters<
      ActionLog['record']
    >[0]);
    const text = audit.summary(24);
    expect(text).toContain('• 09:30 agente shell');
    expect(text).not.toContain('08:30');
  });

  it('/disparadores enseña la última ejecución en hora de Madrid', () => {
    const trigger = {
      id: 't1',
      scope: 'telegram:1',
      routine: 'resumen',
      event: 'mensaje',
      match: 'factura',
      lastFiredAt: '2026-11-05T23:15:00Z',
    } as unknown as RoutineTrigger;
    const text = formatTriggerList([trigger]);
    expect(text).toContain('2026-11-06 00:15');
    expect(text).not.toContain('2026-11-05 23:15');
  });
});
