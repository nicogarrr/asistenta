import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));

import { autostartCommand } from '../src/autostart.js';
import {
  clearStoppedOnPurpose,
  markStoppedOnPurpose,
  readStoppedOnPurpose,
  STOPPED_ON_PURPOSE_FILE,
  schtasksArgs,
  startDaemonTaskArgs,
  WATCHDOG_TASK_NAME,
  watchdogDecide,
  watchdogEnabled,
  watchdogTaskXml,
} from '../src/autostart-watchdog.js';
import { STATE_ENTRIES } from '../src/state-files.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'vigilante-'));
  dirs.push(d);
  return d;
};
let out = '';
const prevEnv = process.env.PA_WATCHDOG;
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
  // Estos tests no lanzan la autoactualización (la cubre autoupdate-cli.test.ts).
  process.env.PA_AUTOUPDATE = '0';
});
afterEach(() => {
  delete process.env.PA_AUTOUPDATE;
  vi.restoreAllMocks();
  if (prevEnv === undefined) delete process.env.PA_WATCHDOG;
  else process.env.PA_WATCHDOG = prevEnv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const calls = () =>
  execFile.mock.calls.map((c) => [String(c[0]).split(/[\\/]/).pop(), c[1] as string[]]);

describe('vigilante del autoarranque: lo que se le pasa a Windows', () => {
  it('XML: al iniciar sesión y cada 5 min, una sola instancia, sin privilegios, oculto', () => {
    const xml = watchdogTaskXml({
      nodeExe: 'C:\\node\\node.exe',
      cliJs: "C:\\Users\\Nico's\\a&b\\dist\\cli.js",
    });
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Interval>PT5M</Interval>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<Hidden>true</Hidden>');
    expect(xml).toContain('-WindowStyle Hidden');
    // comilla simple doblada para PowerShell, & escapado para XML
    expect(xml).toContain("Nico''s\\a&amp;b\\dist\\cli.js' autostart vigilar");
  });

  it('schtasks: crear (idempotente con /F), borrar y consultar por el mismo nombre', () => {
    expect(schtasksArgs.create('C:\\t\\v.xml')).toEqual([
      '/Create',
      '/F',
      '/TN',
      WATCHDOG_TASK_NAME,
      '/XML',
      'C:\\t\\v.xml',
    ]);
    expect(schtasksArgs.remove()).toEqual(['/Delete', '/F', '/TN', WATCHDOG_TASK_NAME]);
    expect(schtasksArgs.query()[0]).toBe('/Query');
    expect(startDaemonTaskArgs().join(' ')).toContain(
      "Get-ScheduledTask -TaskName 'personal-agent-daemon'",
    );
  });

  it('decide: solo arranca si está parada, no hay duda y no la paraste tú desde el último arranque', () => {
    const base = { enabled: true, bootAt: 1_000 };
    expect(watchdogDecide({ ...base, state: 'stopped' })).toEqual({ action: 'start' });
    expect(watchdogDecide({ ...base, state: 'running' }).action).toBe('skip');
    expect(watchdogDecide({ ...base, state: 'unknown' })).toEqual({
      action: 'skip',
      reason: 'dudoso',
    });
    expect(watchdogDecide({ ...base, state: 'stopped', stoppedAt: 2_000 })).toEqual({
      action: 'skip',
      reason: 'parado-a-proposito',
    });
    expect(watchdogDecide({ ...base, state: 'stopped', stoppedAt: 500 })).toEqual({
      action: 'start',
    });
    expect(watchdogDecide({ ...base, enabled: false, state: 'stopped' })).toEqual({
      action: 'skip',
      reason: 'apagado',
    });
  });

  it('PA_WATCHDOG: encendido por defecto; 0/off lo apagan', () => {
    expect(watchdogEnabled({})).toBe(true);
    expect(watchdogEnabled({ PA_WATCHDOG: '0' })).toBe(false);
    expect(watchdogEnabled({ PA_WATCHDOG: ' OFF ' })).toBe(false);
    expect(watchdogEnabled({ PA_WATCHDOG: '1' })).toBe(true);
  });

  it('pa stop lo marca y pa iniciar lo quita', () => {
    const d = tmp();
    markStoppedOnPurpose(d, new Date('2026-10-30T16:00:00Z'));
    expect(readStoppedOnPurpose(d)).toBe(Date.parse('2026-10-30T16:00:00Z'));
    clearStoppedOnPurpose(d);
    expect(existsSync(join(d, STOPPED_ON_PURPOSE_FILE))).toBe(false);
  });
});

describe('pa autostart con el vigilante (todo simulado)', () => {
  it('install registra la tarea con su XML después del instalador', async () => {
    let xmlSeen = '';
    execFile.mockImplementation(
      (_e: string, f: string[], _o: unknown, cb: (...a: unknown[]) => void) => {
        if (f[0] === '/Create')
          xmlSeen = readFileSync(f[5] as string)
            .subarray(2)
            .toString('utf16le');
        cb(null, '', '');
      },
    );
    expect(
      await autostartCommand(['install'], { stateDir: tmp(), cliJs: 'C:\\a\\dist\\cli.js' }),
    ).toBe(0);
    const c = calls();
    expect(c[0]?.[0]).toBe('powershell.exe');
    expect(c[1]).toEqual([
      'schtasks.exe',
      expect.arrayContaining(['/Create', '/F', WATCHDOG_TASK_NAME]),
    ]);
    expect(xmlSeen).toContain("'C:\\a\\dist\\cli.js' autostart vigilar");
    expect(out).toContain('Vigilante: registrado');
  });

  it('install con PA_WATCHDOG=0 o --what-if no lo registra', async () => {
    process.env.PA_WATCHDOG = '0';
    await autostartCommand(['install'], { stateDir: tmp() });
    delete process.env.PA_WATCHDOG;
    await autostartCommand(['install', '--what-if'], { stateDir: tmp() });
    expect(calls().filter(([e]) => e === 'schtasks.exe')).toEqual([]);
  });

  it('install --start la deja encendida: quita la marca de pa stop (como pa iniciar)', async () => {
    const d = tmp();
    markStoppedOnPurpose(d);
    await autostartCommand(['install'], { stateDir: d });
    await autostartCommand(['install', '--start', '--what-if'], { stateDir: d });
    expect(existsSync(join(d, STOPPED_ON_PURPOSE_FILE))).toBe(true);
    await autostartCommand(['install', '--start'], { stateDir: d });
    expect(existsSync(join(d, STOPPED_ON_PURPOSE_FILE))).toBe(false);
  });

  it('install --start fallido no quita la marca de pa stop', async () => {
    const d = tmp();
    markStoppedOnPurpose(d);
    execFile.mockImplementation(
      (_e: string, _f: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
        cb(new Error('falló'), '', ''),
    );
    expect(await autostartCommand(['install', '--start'], { stateDir: d })).toBe(1);
    expect(existsSync(join(d, STOPPED_ON_PURPOSE_FILE))).toBe(true);
  });

  it('uninstall lo borra antes de que el instalador pare Asistenta', async () => {
    await autostartCommand(['uninstall'], { stateDir: tmp() });
    expect(calls()[0]).toEqual(['schtasks.exe', ['/Delete', '/F', '/TN', WATCHDOG_TASK_NAME]]);
    expect(calls()[1]?.[0]).toBe('powershell.exe');
    expect(calls()).toHaveLength(2);
  });

  it('--what-if dice que también registraría o quitaría el vigilante, sin tocarlo', async () => {
    await autostartCommand(['install', '--what-if'], { stateDir: tmp() });
    expect(out).toContain('Vigilante: también se registraría');
    out = '';
    await autostartCommand(['uninstall', '--what-if'], { stateDir: tmp() });
    expect(out).toContain('Vigilante: también se quitaría.');
    process.env.PA_WATCHDOG = '0';
    out = '';
    await autostartCommand(['install', '--what-if'], { stateDir: tmp() });
    expect(out).not.toContain('Vigilante');
    expect(calls().filter(([e]) => e === 'schtasks.exe')).toEqual([]);
  });

  it('status dice si está instalado y su última revisión', async () => {
    const d = tmp();
    await autostartCommand(['vigilar'], { stateDir: d, daemonState: () => 'running', bootAt: 0 });
    out = '';
    await autostartCommand(['status'], { stateDir: d });
    expect(out).toContain('Vigilante: instalado, cada 5 min');
    expect(out).toContain('Última revisión hace 0 min: en marcha.');
    execFile.mockImplementation(
      (_e: string, f: string[], _o: unknown, cb: (...a: unknown[]) => void) =>
        cb(f[0] === '/Query' ? new Error('no existe') : null, '', ''),
    );
    out = '';
    await autostartCommand(['status'], { stateDir: d });
    expect(out).toContain('Vigilante: no instalado');
  });

  it('vigilar arranca la tarea del daemon solo si está parada', async () => {
    const d = tmp();
    await autostartCommand(['vigilar'], { stateDir: d, daemonState: () => 'running', bootAt: 0 });
    await autostartCommand(['vigilar'], { stateDir: d, daemonState: () => 'unknown', bootAt: 0 });
    // En marcha solo pone al día su propia tarea (una vez); no arranca nada.
    expect(calls().map(([exe, a]) => [exe, a?.[0]])).toEqual([['schtasks.exe', '/Create']]);
    execFile.mockClear();
    await autostartCommand(['vigilar'], { stateDir: d, daemonState: () => 'stopped', bootAt: 0 });
    expect(calls()).toEqual([['powershell.exe', startDaemonTaskArgs()]]);
    expect(out).toContain('la arranqué');
  });

  it('vigilar respeta pa stop hasta el siguiente arranque del PC', async () => {
    const d = tmp();
    markStoppedOnPurpose(d, new Date(5_000));
    await autostartCommand(['vigilar'], {
      stateDir: d,
      daemonState: () => 'stopped',
      bootAt: 1_000,
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(out).toContain('la paraste tú');
    await autostartCommand(['vigilar'], {
      stateDir: d,
      daemonState: () => 'stopped',
      bootAt: 9_000,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('vigilar no acepta argumentos', async () => {
    expect(await autostartCommand(['vigilar', '--start'], { stateDir: tmp() })).toBe(2);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('los ficheros del vigilante están registrados en el estado', () => {
    const names = STATE_ENTRIES.map((e) => e.name);
    expect(names).toContain('parado-a-proposito.json');
    expect(names).toContain('vigilante.json');
  });
});

describe('vigilante: carpeta de trabajo de la tarea', () => {
  it('arranca en la raíz del repo (donde está el .env), no en System32', () => {
    const xml = watchdogTaskXml({
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      cliJs: 'C:\\Users\\Nico\\asis & co\\dist\\cli.js',
    });
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\Nico\\asis &amp; co</WorkingDirectory>');
    // El esquema del Programador de tareas exige Command, Arguments, WorkingDirectory en ese orden.
    const exec = xml.slice(xml.indexOf('<Exec>'), xml.indexOf('</Exec>'));
    expect(exec.indexOf('<Arguments>')).toBeLessThan(exec.indexOf('<WorkingDirectory>'));
    expect(exec.indexOf('<Command>')).toBeLessThan(exec.indexOf('<Arguments>'));
  });

  it('también con barras normales en la ruta del CLI', () => {
    const xml = watchdogTaskXml({ nodeExe: 'node.exe', cliJs: 'D:/repos/asistenta/dist/cli.js' });
    expect(xml).toContain('<WorkingDirectory>D:/repos/asistenta</WorkingDirectory>');
  });
});
