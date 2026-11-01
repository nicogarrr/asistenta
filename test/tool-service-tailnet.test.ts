// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceStore } from '../src/services/store.js';
import { type RunResult, createServiceTool } from '../src/tools/service.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-tool-service-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

type Call = { cmd: string; args: string[] };

function setup(opts: { probe?: boolean; runs?: Record<string, RunResult> } = {}) {
  const dir = tmp();
  const services = new ServiceStore({ dir: join(dir, 'registry') });
  const calls: Call[] = [];
  const tool = createServiceTool({
    services,
    servicesDir: join(dir, 'services'),
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      const key = `${cmd} ${args[0] ?? ''}`;
      return opts.runs?.[key] ?? { code: 0, stdout: '', stderr: '' };
    },
    vaultSnapshotValues: async () => [],
    probePort: async () => opts.probe ?? false,
    now: () => '2026-10-28T01:00:00.000Z',
  });
  const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.map((c) => c.text ?? '').join('\n');
  return { services, calls, run, text };
}

const docker = (nombre: string, puerto: number) => ({
  action: 'proponer' as const,
  nombre,
  fuente: `https://github.com/ejemplo/${nombre}`,
  version: '1.0.0',
  licencia: 'MIT',
  coste: 'gratis',
  metodo: 'docker' as const,
  imagen: `ghcr.io/ejemplo/${nombre}:1.0.0`,
  puerto,
});

const serveCalls = (calls: Call[]) =>
  calls.filter((c) => c.cmd === 'tailscale' && c.args[0] === 'serve' && c.args.includes('--bg'));

describe('servicio servir: un solo servicio en https:443 de la tailnet', () => {
  // tailscale serve --https=443 apunta la raíz del nodo a UN puerto. Servir un
  // segundo servicio reemplazaba al primero, cuya ficha seguía diciendo «servido»
  // con su enlace (que ya abría otra cosa); y «parar» el primero hacía serve off
  // y apagaba también el segundo.
  it('no sirve un segundo servicio mientras otro ocupa la tailnet, y lo dice', async () => {
    const { services, calls, run, text } = setup({ probe: true });
    await run(docker('alfa', 8071));
    await run({ action: 'instalar', nombre: 'alfa' });
    expect((await run({ action: 'servir', nombre: 'alfa' })).isError).toBeFalsy();
    await run(docker('beta', 8072));
    await run({ action: 'instalar', nombre: 'beta' });
    const before = serveCalls(calls).length;

    const r = await run({ action: 'servir', nombre: 'beta' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('alfa');
    expect(serveCalls(calls).length).toBe(before);
    expect(services.read('alfa')?.status).toBe('servido');
    expect(services.read('alfa')?.expose).toBe('tailnet');
    expect(services.read('beta')?.expose).toBe('ninguna');
  });

  it('tras parar el que estaba servido, el otro ya se puede servir', async () => {
    const { services, calls, run } = setup({ probe: true });
    await run(docker('alfa', 8071));
    await run({ action: 'instalar', nombre: 'alfa' });
    await run({ action: 'servir', nombre: 'alfa' });
    await run(docker('beta', 8072));
    await run({ action: 'instalar', nombre: 'beta' });

    expect((await run({ action: 'parar', nombre: 'alfa' })).isError).toBeFalsy();
    expect(
      calls.some((c) => c.cmd === 'tailscale' && c.args.join(' ') === 'serve --https=443 off'),
    ).toBe(true);
    expect(services.read('alfa')?.expose).toBe('ninguna');

    const r = await run({ action: 'servir', nombre: 'beta' });
    expect(r.isError).toBeFalsy();
    expect(serveCalls(calls).at(-1)?.args).toContain('http://127.0.0.1:8072');
    expect(services.read('beta')?.status).toBe('servido');
  });

  it('volver a servir el mismo servicio no se bloquea a sí mismo', async () => {
    const { run } = setup({ probe: true });
    await run(docker('alfa', 8071));
    await run({ action: 'instalar', nombre: 'alfa' });
    await run({ action: 'servir', nombre: 'alfa' });
    expect((await run({ action: 'servir', nombre: 'alfa' })).isError).toBeFalsy();
  });
});

describe('servicio: estados que no se pueden saltar', () => {
  it('no se sirve lo que solo está propuesto', async () => {
    const { calls, run, text } = setup();
    await run(docker('alfa', 8071));
    const r = await run({ action: 'servir', nombre: 'alfa' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('instálalo');
    expect(calls.some((c) => c.cmd === 'tailscale')).toBe(false);
  });

  it('si tailscale no está, no expone nada', async () => {
    const { services, run, text } = setup({
      probe: true,
      runs: { 'tailscale version': { code: 1, stdout: '', stderr: 'not found' } },
    });
    await run(docker('alfa', 8071));
    await run({ action: 'instalar', nombre: 'alfa' });
    const r = await run({ action: 'servir', nombre: 'alfa' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Tailscale');
    expect(services.read('alfa')?.expose).toBe('ninguna');
  });

  it('un docker compose up fallido deja el servicio propuesto', async () => {
    const { services, run, text } = setup({
      runs: { 'docker compose': { code: 1, stdout: '', stderr: 'no such image' } },
    });
    await run(docker('alfa', 8071));
    const r = await run({ action: 'instalar', nombre: 'alfa' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Docker no encuentra esa imagen');
    expect(services.read('alfa')?.status).toBe('propuesto');
  });
});
