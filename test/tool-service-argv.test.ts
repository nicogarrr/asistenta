// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceStore } from '../src/services/store.js';
import { createServiceTool, splitCommandLine } from '../src/tools/service.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-svc-argv-'));
  dirs.push(dir);
  const services = new ServiceStore({ dir: join(dir, 'registry') });
  const calls: { cmd: string; args: string[] }[] = [];
  const tool = createServiceTool({
    services,
    servicesDir: join(dir, 'services'),
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    },
    vaultSnapshotValues: async () => [],
    probePort: async () => true,
    now: () => '2026-10-30T13:00:00.000Z',
  });
  const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
  return { calls, run };
}

const base = {
  action: 'proponer' as const,
  nombre: 'tablero',
  fuente: 'https://github.com/x/tablero',
  version: '1.0.0',
  licencia: 'MIT',
  coste: 'gratis',
  metodo: 'local' as const,
  puerto: 8071,
  notas: 'tablero local',
};

describe('servicio local: el comando declarado se parte respetando comillas', () => {
  it('un argumento con espacios entre comillas llega entero, sin las comillas', async () => {
    const { calls, run } = setup();
    await run({ ...base, comando: 'uvx kanvas-board serve --title "Mi tablero" --port 8071' });
    const r = await run({ action: 'instalar', nombre: 'tablero' });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      { cmd: 'uvx', args: ['kanvas-board', 'serve', '--title', 'Mi tablero', '--port', '8071'] },
    ]);
  });

  it('comillas sin cerrar: no ejecuta nada y lo dice', async () => {
    const { calls, run } = setup();
    await run({ ...base, comando: 'uvx kanvas-board --title "Mi tablero' });
    const r = await run({ action: 'instalar', nombre: 'tablero' });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('splitCommandLine', () => {
  it('casos', () => {
    expect(splitCommandLine('  a   b\tc ')).toEqual(['a', 'b', 'c']);
    expect(splitCommandLine(`a 'b c' "d 'e'"`)).toEqual(['a', 'b c', "d 'e'"]);
    expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b']);
    expect(splitCommandLine('C:\\Tools\\app.exe --dir "C:\\Program Files\\X"')).toEqual([
      'C:\\Tools\\app.exe',
      '--dir',
      'C:\\Program Files\\X',
    ]);
    expect(splitCommandLine('echo "di \\"hola\\""')).toEqual(['echo', 'di "hola"']);
    expect(splitCommandLine("a 'b")).toBeNull();
    expect(splitCommandLine('')).toEqual([]);
  });
});
