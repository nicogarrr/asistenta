import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCronCommand } from '../src/cli.js';
import {
  approvalCode,
  COMMAND_PROMPT_PREFIX,
  CommandRoutineStore,
} from '../src/command-routine.js';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

// F4: en la lista de /cron una rutina de comando se distingue de las que
// hablan con el modelo, y se ve si de verdad va a ejecutarse.
describe('/cron lista marca las rutinas de comando', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  const spec = {
    argv: ['node', 'saldo.js', '--cuenta', 'mi banco'],
    cwd: '/tmp',
    timeoutMs: 5_000,
    schedule: '0 8 * * *',
    createdAt: '2026-10-30T08:00:00.000Z',
  };
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let commands: CommandRoutineStore;
  const list = (commandsEnabled: boolean) =>
    runCronCommand(
      { store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT, commands, commandsEnabled },
      '',
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-tag-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    commands = new CommandRoutineStore(join(dir, 'command-routines.json'));
    store.saveRoutine({
      scope: THREAD,
      name: 'resumen',
      kind: 'schedule',
      prompt: 'resumen del día',
      schedule: '0 9 * * *',
    });
    store.saveRoutine({
      scope: THREAD,
      name: 'saldo',
      kind: 'schedule',
      prompt: `${COMMAND_PROMPT_PREFIX}node saldo.js`,
      schedule: spec.schedule,
    });
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('una rutina normal no lleva marca; una de comando sin aprobar dice que no se ejecuta', () => {
    commands.propose(THREAD, 'saldo', spec);
    const out = list(true);
    expect(out).toMatch(/- resumen \[0 9 \* \* \*\]/);
    expect(out).toContain('- saldo ⚙️ comando, sin aprobar (no se ejecuta) [0 8 * * *]');
  });

  it('aprobada pero con PA_CRON_COMANDOS apagado dice cómo activarlo', () => {
    commands.propose(THREAD, 'saldo', spec);
    commands.approve(THREAD, 'saldo', approvalCode(spec));
    expect(list(false)).toContain('- saldo ⚙️ comando, apagado (PA_CRON_COMANDOS=1 para activarlo)');
  });

  it('aprobada y activa enseña el comando exacto', () => {
    commands.propose(THREAD, 'saldo', spec);
    commands.approve(THREAD, 'saldo', approvalCode(spec));
    expect(list(true)).toContain(
      '- saldo ⚙️ comando: node saldo.js --cuenta "mi banco" [0 8 * * *]',
    );
  });

  it('sin registro de comando (json editado o borrado) cuenta como sin aprobar', () => {
    expect(list(true)).toContain('saldo ⚙️ comando, sin aprobar');
  });
});
