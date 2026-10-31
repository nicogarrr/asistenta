import { afterEach, describe, expect, it, vi } from 'vitest';

// En Windows un proponedor .cmd/.bat lanzado con execFile sin shell da EINVAL (igual que npx,
// #1253): el ciclo semanal no podía proponer nada con un PA_EVOLVE_PROPOSER así.

const calls = vi.hoisted(() => [] as Array<{ file: string; shell: unknown }>);
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: vi.fn(
      (
        file: string,
        _args: string[],
        opts: { shell?: unknown },
        cb: (e: null, r: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push({ file, shell: opts.shell });
        cb(null, { stdout: '', stderr: '' });
      },
    ),
  };
});

const { batteryRunnerFromEnv, operatorCommand, proposerFromEnv } = await import(
  '../src/evolve/run.js'
);
const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  calls.length = 0;
});

describe('comandos del operador (.cmd/.bat) en Windows', () => {
  it('operatorCommand: .cmd/.bat con shell y comillas solo en Windows', () => {
    expect(operatorCommand('C:\\Mis cosas\\propon.cmd', 'win32')).toEqual({
      file: '"C:\\Mis cosas\\propon.cmd"',
      shell: true,
    });
    expect(operatorCommand('C:\\x\\p.BAT', 'win32').shell).toBe(true);
    expect(operatorCommand('C:\\x\\p.exe', 'win32')).toEqual({
      file: 'C:\\x\\p.exe',
      shell: false,
    });
    expect(operatorCommand('/opt/p.cmd', 'linux')).toEqual({ file: '/opt/p.cmd', shell: false });
  });
  it('rechaza rutas que cmd.exe reinterpretaría', () => {
    expect(() => operatorCommand('C:\\a"&calc&".cmd', 'win32')).toThrow(/no válida/);
    expect(() => operatorCommand('C:\\%PATH%\\p.bat', 'win32')).toThrow(/no válida/);
  });
  it('el proponedor .cmd va con shell en Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const propose = proposerFromEnv({ PA_EVOLVE_PROPOSER: 'C:\\p\\propon.cmd' });
    await propose?.(process.cwd(), 'h', 1);
    expect(calls).toEqual([{ file: '"C:\\p\\propon.cmd"', shell: true }]);
  });
  it('un PA_EVOLVE_BATTERY .bat también', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const run = batteryRunnerFromEnv({ PA_EVOLVE_BATTERY: 'C:\\b\\caso.bat' });
    await run?.({ id: 'a', prompt: 'hola' } as never, process.cwd()).catch(() => undefined);
    expect(calls[0]).toEqual({ file: '"C:\\b\\caso.bat"', shell: true });
  });
  it('fuera de Windows nada cambia: sin shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await proposerFromEnv({ PA_EVOLVE_PROPOSER: '/opt/propon.sh' })?.(process.cwd(), 'h', 1);
    expect(calls).toEqual([{ file: '/opt/propon.sh', shell: false }]);
  });
});
