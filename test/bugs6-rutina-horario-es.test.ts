import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRoutineStore } from '../src/command-routine.js';
import { programadaEs } from '../src/cron/describe-es.js';
import { runCronCommand } from '../src/daemon/cron-command.js';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

// Al crear una rutina la respuesta decía «programada con horario 0 9 * * *»: el cron
// crudo. Ahora lo dice en español («cada día a las 09:00»), como ya hace la lista.
describe('rutina recién creada: el horario en palabras', () => {
  const CHAT = 'telegram:42';
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let commands: CommandRoutineStore;
  const deps = () => ({
    store,
    routineRunner: runner,
    threadKey: `${CHAT}#main`,
    chatKey: CHAT,
    commands,
    isOwner: true,
    commandsEnabled: true,
    commandCwd: dir,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs6-horario-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    commands = new CommandRoutineStore(join(dir, 'commands.json'));
  });

  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('programadaEs: en palabras, y el cron solo si no se sabe decir', () => {
    expect(programadaEs('0 9 * * *')).toBe('programada: cada día a las 09:00');
    expect(programadaEs('0 9,21 * * *')).toBe('programada: cada día a las 09:00 y 21:00');
    expect(programadaEs('5 4 1-7/2 * *')).toBe('programada con horario 5 4 1-7/2 * *');
  });

  it('«cada mañana a las 9 el resumen» no enseña el cron', () => {
    const r = runCronCommand(deps(), 'add cada mañana a las 9 el resumen del día');
    expect(r).toContain('programada: cada día a las 09:00.');
    expect(r).not.toMatch(/\* \*/);
  });

  it('con un nombre repetido tampoco', () => {
    runCronCommand(deps(), 'add cada mañana a las 9 resumen');
    const r = runCronCommand(deps(), 'add cada mañana a las 9 resumen');
    expect(r).toContain('Horario: cada día a las 09:00.');
    expect(r).not.toMatch(/\* \*/);
  });

  it('rutina de comando: «Horario: cada día a las 08:00»', () => {
    const r = runCronCommand(deps(), 'comando cada día a las 8 ejecuta node saldo.js');
    expect(r).toContain('Horario: cada día a las 08:00');
    expect(r).not.toMatch(/\* \*/);
  });
});
