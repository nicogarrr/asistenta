import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
  spawn: () => {
    throw new Error('los tests nunca lanzan procesos de verdad');
  },
}));

import { autostartCommand } from '../src/autostart.js';
import { startDaemonTaskArgs } from '../src/autostart-watchdog.js';
import { readAutoupdateState, tryLock, writeAutoupdateState } from '../src/autoupdate.js';
import { autoupdateCommand, autoupdateStatusLine } from '../src/autoupdate-cli.js';
import { STATE_ENTRIES } from '../src/state-files.js';

let dir: string;
let out = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-cli-'));
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
  delete process.env.PA_AUTOUPDATE;
  delete process.env.PA_WATCHDOG;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('el vigilante lanza la autoactualización', () => {
  it('con Asistenta en marcha y tocando revisar, lanza `pa autoupdate aplicar` aparte', async () => {
    const launch = vi.fn();
    const opts = {
      stateDir: dir,
      cliJs: 'C:\\a\\dist\\cli.js',
      daemonState: () => 'running' as const,
      bootAt: 0,
    };
    await autostartCommand(['vigilar'], { ...opts, launchAutoupdate: launch });
    expect(launch).toHaveBeenCalledWith(process.execPath, [
      'C:\\a\\dist\\cli.js',
      'autoupdate',
      'aplicar',
    ]);
    expect(out).toContain('miro si hay novedades en main');
    // Revisada hace poco: no vuelve a lanzar hasta pasado el intervalo.
    writeAutoupdateState(dir, { lastCheckAt: new Date().toISOString() });
    launch.mockClear();
    await autostartCommand(['vigilar'], { ...opts, launchAutoupdate: launch });
    expect(launch).not.toHaveBeenCalled();
  });

  it('PA_AUTOUPDATE=0 o pa autoupdate off: el vigilante no la lanza', async () => {
    const launch = vi.fn();
    const opts = {
      stateDir: dir,
      daemonState: () => 'running' as const,
      bootAt: 0,
      launchAutoupdate: launch,
    };
    process.env.PA_AUTOUPDATE = '0';
    await autostartCommand(['vigilar'], opts);
    delete process.env.PA_AUTOUPDATE;
    await autoupdateCommand(['off'], { stateDir: dir, repo: dir });
    await autostartCommand(['vigilar'], opts);
    expect(launch).not.toHaveBeenCalled();
  });

  it('mientras se actualiza (candado), el vigilante no arranca el daemon parado', async () => {
    expect(tryLock(dir)).toBe(true);
    await autostartCommand(['vigilar'], { stateDir: dir, daemonState: () => 'stopped', bootAt: 0 });
    expect(execFile).not.toHaveBeenCalled();
    expect(out).toContain('se está actualizando');
    rmSync(join(dir, 'autoupdate'), { recursive: true, force: true });
    await autostartCommand(['vigilar'], { stateDir: dir, daemonState: () => 'stopped', bootAt: 0 });
    expect(execFile.mock.calls[0]?.[1]).toEqual(startDaemonTaskArgs());
  });
});

describe('pa autoupdate', () => {
  it('status, off y on; PA_AUTOUPDATE=0 manda', async () => {
    await autoupdateCommand(['status'], { stateDir: dir, repo: dir });
    expect(out).toContain('Autoactualización: encendida, revisa main cada 30 min.');
    await autoupdateCommand(['off'], { stateDir: dir, repo: dir });
    expect(readAutoupdateState(dir).off).toBe(true);
    expect(out).toContain('apagada (pa autoupdate off)');
    await autoupdateCommand(['on'], { stateDir: dir, repo: dir });
    expect(autoupdateStatusLine(dir, { PA_AUTOUPDATE: '0' })).toContain(
      'apagada (PA_AUTOUPDATE=0)',
    );
    expect(autoupdateStatusLine(dir, { PA_AUTOUPDATE_INTERVAL_MIN: '60' })).toContain(
      'cada 60 min',
    );
    expect(await autoupdateCommand(['reset'], { stateDir: dir, repo: dir })).toBe(2);
  });

  it('pa autostart status enseña el último resultado', async () => {
    writeAutoupdateState(dir, {
      last: {
        kind: 'actualizada',
        text: 'aaaaaaa → bbbbbbb (3 cambios)',
        at: new Date().toISOString(),
      },
    });
    await autostartCommand(['status'], { stateDir: dir });
    expect(out).toContain('Última (hace 0 min): aaaaaaa → bbbbbbb (3 cambios).');
  });

  it('el estado está registrado y sus registros se podan', () => {
    const e = STATE_ENTRIES.find((x) => x.name === 'autoupdate');
    expect(e?.prune?.match?.test('2026-10-30T18-00-00-000Z.log')).toBe(true);
    expect(e?.prune?.match?.test('estado.json')).toBe(false);
  });
});
