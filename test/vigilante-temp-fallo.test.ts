import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cb = (error: Error | null, stdout: string, stderr: string) => void;
const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));
const fail = { write: '', rm: '' };
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const boom = (code: string) => Object.assign(new Error(`${code}: raw C:\\Temp`), { code });
  return {
    ...real,
    writeFileSync: (...a: Parameters<typeof real.writeFileSync>) => {
      if (fail.write && String(a[0]).includes('asistenta-vigilante')) throw boom(fail.write);
      return real.writeFileSync(...a);
    },
    rmSync: (...a: Parameters<typeof real.rmSync>) => {
      if (fail.rm && String(a[0]).includes('asistenta-vigilante')) throw boom(fail.rm);
      return real.rmSync(...a);
    },
  };
});

const { autostartCommand } = await import('../src/autostart.js');
const { readWatchdogLast } = await import('../src/autostart-watchdog.js');

const realPlatform = process.platform;
let out = '';
let err = '';
let state = '';
beforeEach(() => {
  fail.write = '';
  fail.rm = '';
  out = '';
  err = '';
  state = mkdtempSync(join(tmpdir(), 'pa-vigilante-tmp-'));
  vi.stubEnv('PA_WATCHDOG', '1');
  execFile.mockReset();
  execFile.mockImplementation((_e: string, _f: string[], _o: unknown, cb: Cb) =>
    cb(null, 'Instalación solicitada.\n', ''),
  );
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(state, { recursive: true, force: true });
});

describe('pa autostart install: el vigilante no estropea una instalación buena', () => {
  it('sin poder escribir el XML temporal → línea clara, éxito y sin error en inglés', async () => {
    fail.write = 'ENOSPC';
    expect(await autostartCommand(['install'], { stateDir: state })).toBe(0);
    expect(out).toContain('Instalación solicitada.');
    expect(out).toMatch(/Vigilante: no pude registrarlo[^\n]*carpeta temporal[^\n]*arranca igual/);
    expect(out + err).not.toMatch(/ENOSPC|C:\\Temp|Error/);
    expect(execFile.mock.calls.some((c) => String(c[0]).includes('schtasks'))).toBe(false);
    expect(readWatchdogLast(state)?.text).toMatch(/no se registró/);
  });

  it('si no se puede borrar el XML (antivirus) no falla tras registrar', async () => {
    fail.rm = 'EPERM';
    expect(await autostartCommand(['install'], { stateDir: state })).toBe(0);
    expect(out).toMatch(/Vigilante: registrado/);
    expect(out + err).not.toMatch(/EPERM|Error/);
  });
});
