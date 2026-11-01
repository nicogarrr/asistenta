import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scheduledAgendaText } from '../src/cli.js';
import {
  approvalCode,
  COMMAND_PROMPT_PREFIX,
  CommandRoutineStore,
} from '../src/command-routine.js';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

// /agenda (rutinas) marca las rutinas de comando igual que /cron (#559).
describe('/agenda marca las rutinas de comando', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  const spec = {
    argv: ['node', 'saldo.js'],
    cwd: '/tmp',
    timeoutMs: 5_000,
    schedule: '0 8 * * *',
    createdAt: '2026-10-30T08:00:00.000Z',
  };
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let commands: CommandRoutineStore;
  const agenda = (commandsEnabled: boolean) =>
    scheduledAgendaText({ store, routineRunner: runner, chatKey: CHAT, commands, commandsEnabled });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-agenda-tag-'));
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

  it('la rutina normal va sin marca; la de comando sin aprobar dice que no se ejecuta', () => {
    commands.propose(THREAD, 'saldo', spec);
    const out = agenda(true);
    expect(out).toContain('Rutinas programadas: 2');
    expect(out).toMatch(/- resumen \[0 9 \* \* \*\] — próxima: /);
    expect(out).toContain('- saldo ⚙️ comando, sin aprobar (no se ejecuta) [0 8 * * *]');
  });

  it('aprobada y con PA_CRON_COMANDOS apagado lo dice', () => {
    commands.propose(THREAD, 'saldo', spec);
    commands.approve(THREAD, 'saldo', approvalCode(spec));
    expect(agenda(false)).toContain('- saldo ⚙️ comando, apagado (PA_CRON_COMANDOS=1');
  });

  it('aprobada y activa muestra el comando exacto', () => {
    commands.propose(THREAD, 'saldo', spec);
    commands.approve(THREAD, 'saldo', approvalCode(spec));
    expect(agenda(true)).toContain('- saldo ⚙️ comando: node saldo.js [0 8 * * *]');
  });

  it('otro chat no ve estas rutinas', () => {
    const out = scheduledAgendaText({
      store,
      routineRunner: runner,
      chatKey: 'telegram:777',
      commands,
      commandsEnabled: true,
    });
    expect(out).toBe(
      'No hay rutinas programadas. Si quieres una, dime qué hago y cuándo, por ejemplo «cada mañana a las 8 el resumen del día».',
    );
  });
});
