import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cb = (error: Error | null, stdout: string, stderr: string) => void;
const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));

const { autostartCommand, autostartRepo } = await import('../src/autostart.js');

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });
let out = '';
let err = '';

beforeEach(() => {
  execFile.mockReset();
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('pa autostart', () => {
  it('fuera de Windows no ejecuta nada y sale con 2', async () => {
    setPlatform('linux');
    expect(await autostartCommand(['install'])).toBe(2);
    expect(execFile).not.toHaveBeenCalled();
    expect(err).toMatch(/solo funciona en Windows/);
  });

  it.each([[['borrar']], [['install', '--force']], [['status', '; rm -rf /']]])(
    'rechaza acción o bandera desconocida (%j) sin lanzar PowerShell',
    async (args) => {
      setPlatform('win32');
      expect(await autostartCommand(args)).toBe(2);
      expect(execFile).not.toHaveBeenCalled();
      expect(err).toMatch(/^No conozco esa orden\. Usa: pa autostart install/);
    },
  );

  it('status por defecto: PowerShell con argumentos literales, sin shell, y propaga su salida', async () => {
    setPlatform('win32');
    execFile.mockImplementation((_exe: string, _flags: string[], _opts: unknown, cb: Cb) =>
      cb(null, 'Tarea: OK\n', ''),
    );
    expect(await autostartCommand([])).toBe(0);
    const [exe, flags, opts] = execFile.mock.calls[0] ?? [];
    expect(String(exe)).toMatch(/powershell\.exe$/i);
    expect(flags).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Action', 'status', '-NodeExe']),
    );
    expect(flags[flags.indexOf('-RepoDir') + 1]).toBe(autostartRepo());
    expect(String(flags[flags.indexOf('-File') + 1])).toMatch(/install-all\.ps1$/);
    expect(flags).not.toContain('-Start');
    expect(opts).toMatchObject({ windowsHide: true, timeout: 120_000 });
    expect(out).toMatch(
      /^Última comprobación de arranque \(pa iniciar\)[^\n]*\nAviso al arrancar \(solo si algo falla\)[^\n]*\nTarea: OK\nVigilante: [^\n]*\nAutoactualización: [^\n]*\n$/,
    );
  });

  it('las banderas se traducen a switches de PowerShell, una por una', async () => {
    setPlatform('win32');
    execFile.mockImplementation((_e: string, _f: string[], _o: unknown, cb: Cb) =>
      cb(null, '', ''),
    );
    expect(await autostartCommand(['install', '--start', '--what-if', '--no-local-llm'])).toBe(0);
    const flags = execFile.mock.calls[0]?.[1] as string[];
    expect(flags.slice(-3)).toEqual(['-DisableLocalLlm', '-Start', '-WhatIf']);
    expect(flags[flags.indexOf('-Action') + 1]).toBe('install');
  });

  it('un fallo del instalador da 1 y un mensaje sin volcar stderr de PowerShell', async () => {
    setPlatform('win32');
    execFile.mockImplementation((_e: string, _f: string[], _o: unknown, cb: Cb) =>
      cb(new Error('exit 1'), '', 'C:\\Users\\nico\\secreto.txt: acceso denegado'),
    );
    expect(await autostartCommand(['uninstall'])).toBe(1);
    expect(err).toMatch(/no completado/);
    expect(err).not.toMatch(/secreto/);
  });
});
