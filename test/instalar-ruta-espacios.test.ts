import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { cliWith, makeRun } from '../scripts/instalar.mjs';

/** Node del instalador oficial: «C:\Program Files\nodejs\node.exe» (con espacio). */
function fakeSpawn(calls: { cmd: string; args: string[]; shell: boolean }[]) {
  return (cmd: string, args: string[], opts: { shell: boolean }) => {
    calls.push({ cmd, args, shell: opts.shell });
    const p = new EventEmitter();
    setImmediate(() => p.emit('close', 0));
    return p;
  };
}

it('Windows: «pa vault init» con Node en Program Files va sin shell (la ruta con espacio no se rompe)', async () => {
  const calls: { cmd: string; args: string[]; shell: boolean }[] = [];
  const run = makeRun(fakeSpawn(calls), true);
  const code = await cliWith(run, 'C:\\Program Files\\nodejs\\node.exe')(['vault', 'init']);
  expect(code).toBe(0);
  expect(calls).toEqual([
    {
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['dist/cli.js', 'vault', 'init'],
      shell: false,
    },
  ]);
});

it('Windows: npm sigue yendo con shell (npm.cmd)', async () => {
  const calls: { cmd: string; args: string[]; shell: boolean }[] = [];
  await makeRun(fakeSpawn(calls), true)('npm', ['ci']);
  expect(calls[0]?.shell).toBe(true);
});
