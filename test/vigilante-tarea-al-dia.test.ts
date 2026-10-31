import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile,
}));

import { autostartCommand } from '../src/autostart.js';

let dir: string;
let failCreate = false;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vigilante-tarea-'));
  failCreate = false;
  execFile.mockReset();
  execFile.mockImplementation(
    (_e: string, f: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
      cb(failCreate && f[0] === '/Create' ? new Error('acceso denegado') : null, '', ''),
  );
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  delete process.env.PA_WATCHDOG;
  process.env.PA_AUTOUPDATE = '0';
});
afterEach(() => {
  delete process.env.PA_AUTOUPDATE;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const creates = () => execFile.mock.calls.filter((c) => (c[1] as string[])[0] === '/Create').length;
const vigilar = () =>
  autostartCommand(['vigilar'], {
    stateDir: dir,
    daemonState: () => 'running',
    bootAt: 0,
    cliJs: 'C:\\a\\dist\\cli.js',
    launchAutoupdate: () => {},
  });

describe('vigilante: su tarea de Windows se pone al día sola', () => {
  it('una tarea registrada por una versión anterior se vuelve a registrar una sola vez', async () => {
    await vigilar();
    expect(creates()).toBe(1);
    await vigilar();
    await vigilar();
    expect(creates()).toBe(1);
  });

  it('si la tarea cambió (otra versión, Node en otra ruta), se registra de nuevo', async () => {
    writeFileSync(join(dir, 'vigilante-tarea.json'), JSON.stringify({ sha: 'vieja' }));
    await vigilar();
    expect(creates()).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'vigilante-tarea.json'), 'utf8')).sha).not.toBe(
      'vieja',
    );
  });

  it('si Windows lo rechaza, no reintenta cada 5 min ni rompe la revisión', async () => {
    failCreate = true;
    expect(await vigilar()).toBe(0);
    await vigilar();
    expect(creates()).toBe(1);
  });

  it('con Asistenta parada no toca la tarea: primero la arranca', async () => {
    await autostartCommand(['vigilar'], {
      stateDir: dir,
      daemonState: () => 'stopped',
      bootAt: 0,
      cliJs: 'C:\\a\\dist\\cli.js',
    });
    expect(creates()).toBe(0);
  });
});
