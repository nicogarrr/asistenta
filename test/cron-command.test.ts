import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routineNameFromPrompt, runCronCommand } from '../src/cli.js';
import { parseCronAdd } from '../src/cron/scheduler.js';
import { Store } from '../src/db.js';
import { RoutineRunner, validateSchedule } from '../src/routines.js';

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
  it('the natural branch goes through the validator too (auditor #135 ronda 2)', () => {
    // A rejecting validator must veto a PERFECTLY parseable natural phrase:
    // before the fix, only the "|" branch was validated.
    const rejecting = () => ({ ok: false as const, error: 'rechazado por test' });
    expect(parseCronAdd('cada mañana a las 8 un resumen de mi día', rejecting).ok).toBe(false);
    // And the real validator rejects what parseNatural over-generates.
    expect(parseCronAdd('cada999minutos suerte', validateSchedule).ok).toBe(false);
  });
});

describe('/cron command (store + runner reales)', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  const deps = () => ({ store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-cmd-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('add literal saves and the runner picks it up live', () => {
    const reply = runCronCommand(deps(), 'add 0 8 * * * | resumen del día');
    expect(reply).toContain('programada');
    const r = store.listRoutines()[0];
    if (!r) throw new Error('expected the routine to exist');
    expect(r.scope).toBe(THREAD);
    expect(r.schedule).toBe('0 8 * * *');
    expect(runner.status().some((s) => s.scope === r.scope && s.name === r.name)).toBe(true);
  });

  it('add natural saves the parsed schedule', () => {
    runCronCommand(deps(), 'add cada mañana a las 8 un resumen de mi día');
    const r = store.listRoutines()[0];
    if (!r) throw new Error('expected the routine to exist');
    expect(r.schedule).toBe('0 8 * * *');
  });

  it('an invalid schedule saves nothing and schedules nothing', () => {
    const reply = runCronCommand(deps(), 'add no-es-cron | tarea');
    expect(reply).toContain('horario');
    expect(store.listRoutines()).toHaveLength(0);
    expect(runner.status()).toHaveLength(0);
  });

  it('a repeated add never overwrites: free name, said out loud, first intact', () => {
    runCronCommand(deps(), 'add 0 8 * * * | resumen del día');
    const reply = runCronCommand(deps(), 'add 0 9 * * * | resumen del día');
    expect(reply).toContain('Ya tenías una rutina llamada');
    const all = store.listRoutines();
    expect(all).toHaveLength(2);
    const names = all.map((r) => r.name).sort();
    expect(names[1]).toBe(`${names[0]}-2`);
    expect(all.find((r) => r.name === names[0])?.schedule).toBe('0 8 * * *');
  });

  it('never overwrites a PROCEDURE routine of the same name', () => {
    const base = routineNameFromPrompt('resumen del día');
    store.saveRoutine({
      scope: THREAD,
      name: base,
      kind: 'procedure',
      steps: '["a","b"]',
      prompt: 'macro vieja',
    });
    const reply = runCronCommand(deps(), 'add 0 8 * * * | resumen del día');
    expect(reply).toContain('Ya tenías una rutina llamada');
    const proc = store.getRoutine(THREAD, base);
    expect(proc?.kind).toBe('procedure');
    expect(proc?.steps).toBe('["a","b"]');
    expect(store.getRoutine(THREAD, `${base}-2`)?.kind).toBe('schedule');
  });

  it('the list only sees this chat: telegram:12 does not leak telegram:123', () => {
    store.saveRoutine({
      scope: 'telegram:123#main',
      name: 'ajena',
      kind: 'schedule',
      prompt: 'p',
      schedule: '0 8 * * *',
    });
    const mine = {
      store,
      routineRunner: runner,
      threadKey: 'telegram:12#main',
      chatKey: 'telegram:12',
    };
    expect(runCronCommand(mine, '')).toContain('No hay rutinas programadas');
    store.saveRoutine({
      scope: 'telegram:12#main',
      name: 'mia',
      kind: 'schedule',
      prompt: 'p',
      schedule: '0 9 * * *',
    });
    const reply = runCronCommand(mine, '');
    expect(reply).toContain('mia');
    expect(reply).not.toContain('ajena');
  });

  it('del removes it, drops the live job and promises only what it keeps', () => {
    runCronCommand(deps(), 'add 0 8 * * * | resumen del día');
    const r = store.listRoutines()[0];
    if (!r) throw new Error('expected the routine to exist');
    const reply = runCronCommand(deps(), `del ${r.name}`);
    expect(reply).toContain('no habrá nuevas ejecuciones');
    expect(reply).toContain('en marcha');
    expect(store.getRoutine(THREAD, r.name)).toBeNull();
    expect(runner.status()).toHaveLength(0);
  });

  it('del refuses a procedure (it is not a scheduled routine)', () => {
    store.saveRoutine({ scope: THREAD, name: 'macro-x', kind: 'procedure', steps: '["a"]' });
    const reply = runCronCommand(deps(), 'del macro-x');
    expect(reply).toContain('No tengo ninguna rutina programada');
    expect(store.getRoutine(THREAD, 'macro-x')).not.toBeNull();
  });
});
