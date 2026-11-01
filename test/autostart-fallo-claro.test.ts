import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cb = (error: Error | null, stdout: string, stderr: string) => void;
const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));

const { autostartCommand } = await import('../src/autostart.js');

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });
let err = '';

beforeEach(() => {
  execFile.mockReset();
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
  setPlatform('win32');
});
afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

const failWith = (error: Error, stderr: string) =>
  execFile.mockImplementation((_e: string, _f: string[], _o: unknown, cb: Cb) =>
    cb(error, '', stderr),
  );
const ps1Fail = (motivo: string) =>
  `MOTIVO=${motivo}\r\nNo se completó autoarranque; C:\\Users\\nico\\.env\r\n`;

describe('pa autostart install: fallo explicado en castellano claro', () => {
  it.each([
    ['compilar', /falta compilar Asistenta[^\n]*instalar\.bat/],
    ['navegador', /navegador de Asistenta[^\n]*setup-browserd\.ps1/],
    ['archivos', /faltan archivos de Asistenta/],
    ['node', /Node 24[^\n]*nodejs\.org/],
    ['permiso', /permiso[^\n]*administrador/],
  ])('motivo %s → qué pasó y qué hacer, sin volcar stderr', async (motivo, re) => {
    failWith(new Error('Command failed'), ps1Fail(motivo));
    expect(await autostartCommand(['install'])).toBe(1);
    expect(err).toMatch(/^Autoarranque no completado: /);
    expect(err).toMatch(re);
    expect(err).not.toMatch(/MOTIVO|\.env|nico/);
    expect(err.trim().split('\n')).toHaveLength(1);
  });

  it('uninstall sin parada limpia → pide pa stop', async () => {
    failWith(new Error('Command failed'), ps1Fail('parada'));
    expect(await autostartCommand(['uninstall'])).toBe(1);
    expect(err).toMatch(/no pude parar Asistenta[^\n]*pa stop/);
  });

  it('sin PowerShell (ENOENT) lo dice claro', async () => {
    failWith(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '');
    expect(await autostartCommand(['install'])).toBe(1);
    expect(err).toMatch(/no encuentro Windows PowerShell/);
    expect(err).not.toMatch(/ENOENT|spawn/);
  });

  it('instalador colgado (timeout) lo dice claro', async () => {
    failWith(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '');
    expect(await autostartCommand(['install'])).toBe(1);
    expect(err).toMatch(/tardó más de 2 minutos/);
  });

  it('motivo desconocido → frase genérica con siguiente paso (pa doctor)', async () => {
    failWith(new Error('Command failed'), 'Register-ScheduledTask : algo raro en C:\\x');
    expect(await autostartCommand(['install'])).toBe(1);
    expect(err).toMatch(/^Autoarranque no completado: [^\n]*pa doctor/);
    expect(err).not.toMatch(/Register-ScheduledTask|C:\\/);
  });

  it('install-all.ps1 emite cada motivo que pa autostart sabe explicar', () => {
    const ps1 = readFileSync(new URL('../deploy/windows/install-all.ps1', import.meta.url), 'utf8');
    expect(ps1).toContain("[Console]::Error.WriteLine('MOTIVO='+$motivo)");
    for (const m of ['compilar', 'navegador', 'archivos', 'node', 'parada', 'permiso', 'otro']) {
      expect(ps1).toContain(`'${m}'`);
    }
  });
});
