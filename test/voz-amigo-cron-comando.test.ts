import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRoutineStore, parseCommandAdd } from '../src/command-routine.js';
import { parseNatural } from '../src/cron/scheduler.js';
import { runCronCommand } from '../src/daemon/cron-command.js';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { Store } from '../src/db.js';
import { RoutineRunner, validateSchedule } from '../src/routines.js';

// Nico (1 nov): «como estamos hablando nosotros». Las rutinas de comando enseñaban
// «Formato: /cron comando <horario cron> … -- <programa>». Ahora preguntan normal
// y entienden «cada día a las 8 ejecuta node saldo.js».
describe('rutinas de comando habladas normal', () => {
  const CHAT = 'telegram:42';
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let preguntas: PreguntasPendientes;
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
    ask: (opts: Parameters<PreguntasPendientes['ask']>[2]) => preguntas.ask(CHAT, 'cron', opts),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-comando-amigo-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    preguntas = new PreguntasPendientes(() => 0);
    commands = new CommandRoutineStore(join(dir, 'commands.json'));
  });

  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sin programa pregunta normal, sin sintaxis de comandos', () => {
    const r = runCronCommand(deps(), 'comando');
    expect(r).toBe(
      '¿Qué programa ejecuto y cuándo? Dímelo normal, por ejemplo «cada día a las 8 ejecuta node C:\\scripts\\saldo.js».',
    );
    expect(r).not.toMatch(/\/cron|<[a-z]|Formato/);
  });

  it('la respuesta normal propone el comando con su código', () => {
    runCronCommand(deps(), 'comando');
    const cmd = preguntas.consume(CHAT, 'cada día a las 8 ejecuta node saldo.js');
    expect(cmd?.args).toBe('comando cada día a las 8 ejecuta node saldo.js');
    const r = runCronCommand(deps(), cmd?.args ?? '');
    expect(r).toContain('Programa y argumentos: node saldo.js');
    expect(r).toContain('Horario: cada día a las 08:00');
  });

  it('parseCommandAdd entiende el horario en palabras y sigue aceptando el de siempre', () => {
    const natural = (w: string) => parseNatural(w)?.schedule ?? null;
    const ok = parseCommandAdd(
      'cada lunes a las 9 lanza python "C:\\a b\\x.py"',
      validateSchedule,
      natural,
    );
    expect(ok).toEqual({
      ok: true,
      value: {
        schedule: '0 9 * * 1',
        argv: ['python', 'C:\\a b\\x.py'],
        timeoutMs: expect.any(Number),
      },
    });
    expect(parseCommandAdd('0 8 * * * -- node x.js', validateSchedule, natural).ok).toBe(true);
    expect(parseCommandAdd('cuando puedas ejecuta node x.js', validateSchedule, natural).ok).toBe(
      false,
    );
    expect(parseCommandAdd('cada día a las 8 ejecuta node x.js', validateSchedule).ok).toBe(false);
  });

  it('el aviso de comando cambiado ya no manda a /cron comando', () => {
    const src = readFileSync('src/command-routine.ts', 'utf8');
    expect(src).not.toContain('Vuelve a crearlo con /cron comando.');
    expect(src).not.toContain('Formato: /cron comando');
  });
});
