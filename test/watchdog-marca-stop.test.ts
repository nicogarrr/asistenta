import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));

import { autostartCommand } from '../src/autostart.js';
import { markStoppedOnPurpose, watchdogDecide } from '../src/autostart-watchdog.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'vigilante-marca-'));
  dirs.push(d);
  return d;
};
let out = '';
beforeEach(() => {
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const NOW = 10 * 24 * HOUR;
const base = { enabled: true, state: 'stopped' as const, bootAt: NOW - 2 * HOUR, now: NOW };

describe('vigilante: marca de pa stop con fecha futura (reloj adelantado)', () => {
  it('no bloquea el relanzado hasta esa fecha', () => {
    expect(watchdogDecide({ ...base, stoppedAt: NOW + 3 * HOUR })).toEqual({ action: 'start' });
    expect(watchdogDecide({ ...base, stoppedAt: NOW + 30 * 24 * HOUR })).toEqual({
      action: 'start',
    });
  });

  it('un desfase pequeño del reloj sigue contando como pa stop', () => {
    expect(watchdogDecide({ ...base, stoppedAt: NOW + 60_000 })).toEqual({
      action: 'skip',
      reason: 'parado-a-proposito',
    });
    expect(watchdogDecide({ ...base, stoppedAt: NOW - HOUR })).toEqual({
      action: 'skip',
      reason: 'parado-a-proposito',
    });
  });

  it('vigilar arranca aunque la marca diga una fecha de dentro de dos días', async () => {
    const d = tmp();
    markStoppedOnPurpose(d, new Date(Date.now() + 48 * HOUR));
    await autostartCommand(['vigilar'], {
      stateDir: d,
      daemonState: () => 'stopped',
      bootAt: Date.now() - HOUR,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(out).toContain('la arranqué');
  });
});

describe('vigilante: inicio rápido de Windows (el uptime no se reinicia al apagar)', () => {
  it('si Asistenta arrancó después de pa stop, la marca ya no vale', () => {
    expect(
      watchdogDecide({ ...base, stoppedAt: NOW - HOUR, daemonStartedAt: NOW - 30 * 60_000 }),
    ).toEqual({ action: 'start' });
  });

  it('un arranque anterior a pa stop no anula la marca', () => {
    expect(
      watchdogDecide({ ...base, stoppedAt: NOW - HOUR, daemonStartedAt: NOW - 90 * 60_000 }),
    ).toEqual({ action: 'skip', reason: 'parado-a-proposito' });
  });

  it('vigilar relanza si el agent.pid es posterior a pa stop (se cayó tras encender)', async () => {
    const d = tmp();
    const now = Date.now();
    markStoppedOnPurpose(d, new Date(now - 2 * HOUR));
    // Encendido con inicio rápido: el «arranque del PC» sigue siendo el de hace un día.
    const opts = { stateDir: d, daemonState: () => 'stopped' as const, bootAt: now - 24 * HOUR };
    await autostartCommand(['vigilar'], opts);
    expect(execFile).not.toHaveBeenCalled();
    expect(out).toContain('la paraste tú');
    // La tarea de inicio de sesión la arrancó (deja agent.pid) y luego se cayó.
    const pid = join(d, 'agent.pid');
    writeFileSync(pid, '4242');
    const started = new Date(now - HOUR);
    utimesSync(pid, started, started);
    await autostartCommand(['vigilar'], opts);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(out).toContain('la arranqué');
  });
});
