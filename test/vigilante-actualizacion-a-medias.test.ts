import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile,
}));

import { autostartCommand, WATCHDOG_REPAIR_FIRST } from '../src/autostart.js';
import { writeAutoupdateState } from '../src/autoupdate.js';

let dir: string;
let out = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vigilante-medias-'));
  out = '';
  execFile.mockReset();
  execFile.mockImplementation(
    (_e: string, _f: string[], _o: unknown, cb: (...a: unknown[]) => void) => cb(null, '', ''),
  );
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  delete process.env.PA_WATCHDOG;
  process.env.PA_AUTOUPDATE = '0';
});
afterEach(() => {
  delete process.env.PA_AUTOUPDATE;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const aMedias = () =>
  writeAutoupdateState(dir, {
    lastCheckAt: new Date().toISOString(),
    pending: { from: 'a'.repeat(40), to: 'b'.repeat(40), at: new Date().toISOString() },
  });

describe('vigilante con una actualización a medias', () => {
  it('con Asistenta parada, primero lanza el arreglo y no arranca la versión a medias', async () => {
    aMedias();
    const launch = vi.fn();
    await autostartCommand(['vigilar'], {
      stateDir: dir,
      daemonState: () => 'stopped',
      bootAt: 0,
      cliJs: 'C:\\a\\dist\\cli.js',
      launchAutoupdate: launch,
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[1]).toEqual(['C:\\a\\dist\\cli.js', 'autoupdate', 'aplicar']);
    expect(execFile).not.toHaveBeenCalled();
    expect(out).toContain(WATCHDOG_REPAIR_FIRST);
  });

  it('sin nada a medias, la arranca como siempre', async () => {
    const launch = vi.fn();
    await autostartCommand(['vigilar'], {
      stateDir: dir,
      daemonState: () => 'stopped',
      bootAt: 0,
      launchAutoupdate: launch,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('si el arreglo no se puede lanzar, la arranca igual', async () => {
    aMedias();
    await autostartCommand(['vigilar'], {
      stateDir: dir,
      daemonState: () => 'stopped',
      bootAt: 0,
      launchAutoupdate: () => {
        throw new Error('no');
      },
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
