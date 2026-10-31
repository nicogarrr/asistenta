import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cb = (error: Error | null, stdout: string, stderr: string) => void;
const execFile = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...args: unknown[]) => execFile(...args),
}));
const warn = vi.fn();
vi.mock('../src/log.js', async (orig) => {
  const real = await orig<typeof import('../src/log.js')>();
  return { ...real, logFile: { ...real.logFile, warn: (...a: unknown[]) => warn(...a) } };
});

const { autostartCommand } = await import('../src/autostart.js');

const realPlatform = process.platform;
let err = '';
beforeEach(() => {
  execFile.mockReset();
  warn.mockReset();
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.restoreAllMocks();
});

describe('pa autostart: el detalle del fallo va al registro', () => {
  it('el instalador falla: línea llana en consola, salida de PowerShell al registro', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    execFile.mockImplementation((_e: string, _f: string[], _o: unknown, cb: Cb) =>
      cb(new Error('exit 1'), '', 'Register-ScheduledTask : Acceso denegado (0x80070005)'),
    );
    expect(await autostartCommand(['uninstall'])).toBe(1);
    expect(err).toMatch(/no completado/);
    expect(err).not.toContain('0x80070005');
    expect(warn).toHaveBeenCalledWith(
      'autostart: installer failed',
      expect.objectContaining({ stderr: expect.stringContaining('0x80070005') }),
    );
  });
});
