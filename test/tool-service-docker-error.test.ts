// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceStore } from '../src/services/store.js';
import { type RunResult, createServiceTool, dockerFailText } from '../src/tools/service.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

const DAEMON_DOWN =
  'error during connect: this error may indicate that the docker daemon is not running: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.47/containers/json": open //./pipe/docker_engine: The system cannot find the file specified.';

/** Docker compose answers per sub-command: `up`, `stop`, `ps`… keyed by the last argv word that matters. */
function setup(docker: Record<string, RunResult>) {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-tool-service-docker-'));
  dirs.push(dir);
  const tool = createServiceTool({
    services: new ServiceStore({ dir: join(dir, 'registry') }),
    servicesDir: join(dir, 'services'),
    run: async (cmd, args) => {
      if (cmd === 'docker') {
        const step = args.find((a) => a === 'up' || a === 'stop' || a === 'ps') ?? '';
        return docker[step] ?? { code: 0, stdout: 'kanvas', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    vaultSnapshotValues: async () => [],
    probePort: async () => true,
    now: () => '2026-10-31T09:00:00.000Z',
  });
  const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => c.text ?? '').join('\n');
  return { run, text };
}

const proposal = {
  action: 'proponer',
  nombre: 'kanvas',
  fuente: 'https://github.com/XMihura/Kanvas',
  version: '0.4.0',
  licencia: 'MIT',
  coste: 'gratis',
  metodo: 'docker',
  imagen: 'ghcr.io/xmihura/kanvas:0.4.0',
  puerto: 8071,
  notas: 'Tablero visual de tareas.',
};

describe('servicio: errores de Docker en castellano llano', () => {
  it('parar con Docker apagado: dice que abra Docker Desktop, sin la tubería ni el código', async () => {
    const { run, text } = setup({ stop: { code: 1, stdout: '', stderr: DAEMON_DOWN } });
    await run(proposal);
    const inst = await run({ action: 'instalar', nombre: 'kanvas' });
    expect(inst.isError).toBeFalsy();
    const r = await run({ action: 'parar', nombre: 'kanvas' });
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toContain('Docker no está arrancado');
    expect(t).toContain('Docker Desktop');
    expect(t).not.toMatch(/pipe|docker_engine|v1\.47|error during connect|compose stop/);
  });

  it('arrancar con el puerto ocupado: frase clara, sin el texto de Docker', async () => {
    const raw =
      'Error response from daemon: driver failed programming external connectivity on endpoint asistenta-svc-kanvas: Bind for 127.0.0.1:8071 failed: port is already allocated';
    const { run, text } = setup({ up: { code: 1, stdout: '', stderr: raw } });
    await run(proposal);
    const r = await run({ action: 'instalar', nombre: 'kanvas' });
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).toContain('No pude arrancarlo');
    expect(t).toContain('otro programa');
    expect(t).not.toMatch(/Error response|endpoint|compose up/);
  });

  it('cada caso conocido tiene su frase; lo desconocido no se pega tal cual', () => {
    const f = (stderr: string) => dockerFailText({ code: 1, stdout: '', stderr });
    expect(f('spawn docker ENOENT')).toContain('no encuentro Docker');
    expect(f("'docker' is not recognized as an internal or external command")).toContain(
      'no encuentro Docker',
    );
    expect(f('ETIMEDOUT')).toContain('2 minutos');
    expect(f('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')).toContain(
      'no está arrancado',
    );
    expect(f('pull access denied for foo, repository does not exist')).toContain('esa imagen');
    expect(f('permission denied while trying to connect to the Docker daemon socket')).toContain(
      'permiso denegado',
    );
    expect(f('open C:\\Users\\Nico\\x: Access is denied.')).toContain('permiso denegado');
    const other = f('panic: runtime error: index out of range [3] with length 2 goroutine 1');
    expect(other).toContain('no reconozco');
    expect(other).not.toContain('goroutine');
  });
});
