import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// En Windows npx es npx.cmd: execFile('npx') sin shell da ENOENT (o EINVAL con un .cmd), así
// que measure() fallaba siempre en el PC de Nico y ninguna semana de evolve podía arrancar.

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

const { measure, npxCommand } = await import('../src/evolve/measure.js');
const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const dirs: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  calls.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('measure lanza npx de forma que Windows lo encuentra', () => {
  it('npxCommand: npx.cmd con shell en Windows, npx sin shell en el resto', () => {
    expect(npxCommand('win32')).toEqual({ file: 'npx.cmd', shell: true });
    expect(npxCommand('linux')).toEqual({ file: 'npx', shell: false });
    expect(npxCommand('darwin')).toEqual({ file: 'npx', shell: false });
  });
  it('en Windows, la suite y la sonda van por npx.cmd con shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-npx-'));
    dirs.push(dir);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await measure({ cwd: dir });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.file === 'npx.cmd' && c.shell === true)).toBe(true);
  });
  it('en Linux sigue igual: npx sin shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-npx-'));
    dirs.push(dir);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await measure({ cwd: dir });
    expect(calls.map((c) => [c.file, c.shell])).toEqual([
      ['npx', false],
      ['npx', false],
    ]);
  });
});
