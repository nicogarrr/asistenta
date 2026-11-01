import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routineNameFromPrompt, runCronCommand } from '../src/cli.js';
import {
  approvalCode,
  COMMAND_MAX_OUTPUT,
  COMMAND_PROMPT_PREFIX,
  CommandRoutineStore,
  fireCommandRoutine,
  formatCommandResult,
  isApproved,
  parseCommandAdd,
  runCommand,
  splitArgv,
} from '../src/command-routine.js';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import { type Routine, Store } from '../src/db.js';
import { RoutineDeliveryStore } from '../src/routine-delivery.js';
import { RoutineRunner, validateSchedule } from '../src/routines.js';

const node = process.execPath;
const SCOPE = 'telegram:dm:42#main';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-cmdroutine-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('splitArgv / parseCommandAdd', () => {
  it('trocea sin shell: comillas agrupan y ; | $() son texto', () => {
    expect(splitArgv(`node -e "console.log(1)" 'a b' x;rm $(y)`)).toEqual([
      'node',
      '-e',
      'console.log(1)',
      'a b',
      'x;rm',
      '$(y)',
    ]);
    expect(splitArgv('echo "sin cerrar')).toBeNull();
    expect(splitArgv('a "" b')).toEqual(['a', '', 'b']);
    expect(splitArgv('"C:\\a b\\x.js" "di \\"hola\\""')).toEqual(['C:\\a b\\x.js', 'di "hola"']);
  });

  it('exige `--`, valida el horario y acota el tope a 120 s', () => {
    expect(parseCommandAdd('0 8 * * * node x.js', validateSchedule).ok).toBe(false);
    expect(parseCommandAdd('no-cron -- node x.js', validateSchedule).ok).toBe(false);
    expect(parseCommandAdd('0 8 * * * --timeout 500 -- node x.js', validateSchedule).ok).toBe(
      false,
    );
    const ok = parseCommandAdd('0 8 * * * --timeout 30 -- node "C:\\a b\\x.js"', validateSchedule);
    expect(ok).toEqual({
      ok: true,
      value: { schedule: '0 8 * * *', argv: ['node', 'C:\\a b\\x.js'], timeoutMs: 30_000 },
    });
  });
});

describe('aprobación ligada al hash exacto', () => {
  const base = {
    argv: [node, '-e', 'console.log("hola")'],
    cwd: '/tmp',
    timeoutMs: 5_000,
    schedule: '0 8 * * *',
    createdAt: '2026-10-30T08:00:00.000Z',
  };

  it('una propuesta no está aprobada; un código equivocado no aprueba; el correcto sí', () => {
    const s = new CommandRoutineStore(join(dir, 'c.json'));
    const p = s.propose(SCOPE, 'saldo', base);
    expect(isApproved(p)).toBe(false);
    expect(s.approve(SCOPE, 'saldo', '00000000')).toBeNull();
    expect(s.approve(SCOPE, 'saldo', approvalCode(base))).not.toBeNull();
    expect(isApproved(s.get(SCOPE, 'saldo') as never)).toBe(true);
  });

  it('editar argv a mano en el JSON invalida la aprobación y NO ejecuta nada', async () => {
    const file = join(dir, 'c.json');
    const s = new CommandRoutineStore(file);
    s.propose(SCOPE, 'saldo', base);
    s.approve(SCOPE, 'saldo', approvalCode(base));
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw[`${SCOPE}\u0000saldo`].argv = [node, '-e', 'console.log("otro")'];
    writeFileSync(file, JSON.stringify(raw));
    const spawnImpl = vi.fn(() => {
      throw new Error('no debe lanzarse');
    });
    const r = await fireCommandRoutine(
      s,
      { scope: SCOPE, name: 'saldo', schedule: '0 8 * * *' },
      { enabled: true, spawnImpl: spawnImpl as never },
    );
    expect(r.failed).toBe(true);
    expect(r.body).toContain('no coincide');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('un horario distinto del aprobado tampoco ejecuta; apagado no ejecuta', async () => {
    const s = new CommandRoutineStore(join(dir, 'c.json'));
    s.propose(SCOPE, 'saldo', base);
    s.approve(SCOPE, 'saldo', approvalCode(base));
    const spawnImpl = vi.fn();
    const moved = await fireCommandRoutine(
      s,
      { scope: SCOPE, name: 'saldo', schedule: '* * * * *' },
      { enabled: true, spawnImpl: spawnImpl as never },
    );
    expect(moved.failed).toBe(true);
    const off = await fireCommandRoutine(
      s,
      { scope: SCOPE, name: 'saldo', schedule: '0 8 * * *' },
      { enabled: false, spawnImpl: spawnImpl as never },
    );
    expect(off.body).toContain('desactivadas');
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('runCommand (proceso real, sin shell)', () => {
  it('entrega la salida tal cual y los metacaracteres no se interpretan', async () => {
    const r = await runCommand({
      argv: [node, '-e', 'console.log(process.argv[1])', 'a; echo PWNED'],
      cwd: dir,
      timeoutMs: 20_000,
    });
    expect(formatCommandResult(r, 20_000)).toEqual({ body: 'a; echo PWNED', failed: false });
  });

  it('exit≠0 avisa con las últimas líneas de stderr', async () => {
    const r = await runCommand({
      argv: [node, '-e', 'console.error("uno\\ndos\\nboom"); process.exit(3)'],
      cwd: dir,
      timeoutMs: 20_000,
    });
    const f = formatCommandResult(r, 20_000);
    expect(f.failed).toBe(true);
    expect(f.body).toContain('Falló (código 3)');
    expect(f.body).toContain('boom');
  });

  it('el tope de tiempo mata el proceso', async () => {
    const t0 = Date.now();
    const r = await runCommand({
      argv: [node, '-e', 'setTimeout(() => {}, 60000)'],
      cwd: dir,
      timeoutMs: 500,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(formatCommandResult(r, 500).body).toContain('Se cortó');
  });

  it('en Windows el tope mata el árbol entero con taskkill /T', async () => {
    const { EventEmitter } = await import('node:events');
    let child: InstanceType<typeof EventEmitter> & { pid: number; kill: () => void };
    const spawnImpl = vi.fn((file: string) => {
      if (file === 'taskkill.exe') {
        setImmediate(() => child.emit('close', 1));
        return new EventEmitter();
      }
      child = Object.assign(new EventEmitter(), { pid: 777, kill: vi.fn() });
      return child;
    });
    const r = await runCommand(
      { argv: ['script.bat'], cwd: dir, timeoutMs: 50 },
      spawnImpl as never,
      'win32',
    );
    expect(r.timedOut).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith('taskkill.exe', ['/F', '/T', '/PID', '777'], {
      windowsHide: true,
    });
  });

  it('un programa que no existe se dice claro', async () => {
    const r = await runCommand({ argv: ['no-existe-pa-xyz'], cwd: dir, timeoutMs: 5_000 });
    expect(formatCommandResult(r, 5_000)).toMatchObject({ failed: true });
  });

  it('la salida larga se recorta', () => {
    const f = formatCommandResult(
      { code: 0, stdout: 'x'.repeat(10_000), stderr: '', timedOut: false },
      1,
    );
    expect(f.body.length).toBeLessThan(COMMAND_MAX_OUTPUT + 100);
    expect(f.body).toContain('recortado');
  });
});

describe('disparo: una rutina de comando nunca llama al modelo', () => {
  const routine = (): Routine => ({
    id: 'r1',
    scope: SCOPE,
    name: 'saldo',
    kind: 'schedule',
    params: null,
    steps: null,
    prompt: `${COMMAND_PROMPT_PREFIX}node x.js`,
    schedule: '0 8 * * *',
    enabled: true,
    createdAt: '2026-10-30T08:00:00.000Z',
    updatedAt: '2026-10-30T08:00:00.000Z',
    lastRunAt: null,
  });
  const deps = (over: Partial<Parameters<typeof createRoutineFire>[0]> = {}) => {
    const send = vi.fn(async (_chatId: string, _text: string) => ({}));
    const runTask = vi.fn(async (): Promise<string> => {
      throw new Error('el modelo no debe llamarse');
    });
    const delivery = new RoutineDeliveryStore(join(dir, 'delivery.json'));
    const d = {
      store: {} as Store,
      tickGoal: vi.fn(async () => {}),
      runTask,
      send,
      delivery,
      outputDir: join(dir, 'salidas'),
      sync: vi.fn(),
      droppedRemindersPath: join(dir, 'dropped.jsonl'),
      ...over,
    };
    return { d, send, runTask, delivery };
  };

  it('función apagada: avisa y no ejecuta nada', async () => {
    const { d, send, runTask } = deps();
    await createRoutineFire(d)('meta', { scope: SCOPE, routine: routine() });
    expect(runTask).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[1])).toContain('desactivadas');
  });

  it('entrega la salida del comando y «solo si cambia» silencia la repetición', async () => {
    const fireCommand = vi.fn(async () => ({ body: 'saldo: 100 €', failed: false }));
    const { d, send, runTask, delivery } = deps({ fireCommand });
    delivery.set(SCOPE, 'saldo', { target: 'chat', soloSiCambia: true });
    const fire = createRoutineFire(d);
    await fire('meta', { scope: SCOPE, routine: routine() });
    await fire('meta', { scope: SCOPE, routine: routine() });
    expect(runTask).not.toHaveBeenCalled();
    expect(fireCommand).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[1])).toContain('saldo: 100 €');
  });
});

describe('/cron comando', () => {
  let store: Store;
  let runner: RoutineRunner;
  beforeEach(() => {
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
  });
  afterEach(async () => {
    await runner.stop?.();
    store.close();
  });
  const cron = (args: string, over: Record<string, unknown> = {}) =>
    runCronCommand(
      {
        store,
        routineRunner: runner,
        threadKey: SCOPE,
        chatKey: 'telegram:dm:42',
        commands: new CommandRoutineStore(join(dir, 'c.json')),
        isOwner: true,
        commandCwd: dir,
        commandsEnabled: true,
        ...over,
      } as never,
      args,
    );

  it('apagado o fuera del DM del dueño: no propone nada', () => {
    expect(cron('comando 0 8 * * * -- node x.js', { commandsEnabled: false })).toContain(
      'PA_CRON_COMANDOS=1',
    );
    expect(cron('comando 0 8 * * * -- node x.js', { isOwner: false })).toContain('Solo el dueño');
  });

  it('proponer no programa; confirmar con el código exacto sí; /cron del lo borra', () => {
    const reply = cron('comando 0 8 * * * -- node "C:\\scripts\\saldo.js"');
    expect(reply).toContain('C:\\scripts\\saldo.js');
    const code = /con el código ([0-9a-f]{8})\./.exec(reply)?.[1];
    expect(code).toBeDefined();
    const name = routineNameFromPrompt('comando node');
    expect(store.getRoutine(SCOPE, name as string)).toBeNull();
    expect(cron(`comando confirmar ${name} deadbeef`)).toContain('no corresponde');
    expect(store.getRoutine(SCOPE, name as string)).toBeNull();
    expect(cron(`comando confirmar ${name} ${code}`)).toContain('No usa el modelo');
    const saved = store.getRoutine(SCOPE, name as string);
    expect(saved?.prompt?.startsWith(COMMAND_PROMPT_PREFIX)).toBe(true);
    expect(saved?.schedule).toBe('0 8 * * *');
    cron(`del ${name}`);
    expect(new CommandRoutineStore(join(dir, 'c.json')).get(SCOPE, name as string)).toBeNull();
  });
});
