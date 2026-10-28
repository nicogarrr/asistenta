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

const proposal = {
  action: 'proponer' as const,
  nombre: 'kanvas',
  fuente: 'https://github.com/XMihura/Kanvas',
  version: '0.4.0rc4',
  licencia: 'MIT',
  coste: 'gratis (PyPI, MIT)',
  metodo: 'local' as const,
  comando: 'uvx kanvas-board serve --port 8071',
  puerto: 8071,
  notas: 'Tablero visual de tareas; CLI Python sin dependencias.',
};

describe('servicio proponer', () => {
  it('registers a vetted proposal with honest unverified notes', async () => {
    const { services, run, text } = setup();
    const r = await run(proposal);
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain('Servicio propuesto: "kanvas"');
    expect(t).toContain('MIT');
    expect(t).toContain('NO verificado');
    const s = services.read('kanvas');
    expect(s?.status).toBe('propuesto');
    expect(s?.installRef).toBe('uvx kanvas-board serve --port 8071');
    expect(s?.unverified.length).toBeGreaterThan(0);
  });

  it('refuses a license outside the allowlist', async () => {
    const { services, run, text } = setup();
    const r = await run({ ...proposal, licencia: 'SSPL-1.0' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('licencia');
    expect(services.read('kanvas')).toBeNull();
  });

  it('refuses anything that smells of cost', async () => {
    const { services, run, text } = setup();
    const r = await run({ ...proposal, notas: 'tiene plan de pago premium' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('€0');
    expect(services.read('kanvas')).toBeNull();
  });

  it('blocks a proposal whose content matches a vault value', async () => {
    const dir = tmp();
    const services = new ServiceStore({ dir: join(dir, 'registry') });
    const tool = createServiceTool({
      services,
      servicesDir: join(dir, 'services'),
      vaultSnapshotValues: async () => ['CAN4RY-valor-secreto'],
    });
    const r = await tool.execute('c', {
      ...proposal,
      comando: 'uvx kanvas-board --token CAN4RY-valor-secreto',
    } as never);
    expect(r.isError).toBe(true);
    expect(services.read('kanvas')).toBeNull();
  });
});

describe('servicio instalar', () => {
  it('runs the declared local command and records honest verification', async () => {
    const { services, calls, run, text } = setup({ probe: true });
    await run(proposal);
    const r = await run({ action: 'instalar', nombre: 'kanvas' });
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([{ cmd: 'uvx', args: ['kanvas-board', 'serve', '--port', '8071'] }]);
    const t = text(r);
    expect(t).toContain('instalado');
    expect(t).toContain('http://127.0.0.1:8071 responde');
    const s = services.read('kanvas');
    expect(s?.status).toBe('instalado');
    expect(s?.verified.some((v) => v.includes('127.0.0.1:8071'))).toBe(true);
  });

  it('says plainly when the port does not answer', async () => {
    const { services, run, text } = setup({ probe: false });
    await run(proposal);
    const r = await run({ action: 'instalar', nombre: 'kanvas' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('NO respondió');
    expect(services.read('kanvas')?.unverified.some((v) => v.includes('NO respondió'))).toBe(true);
  });

  it('fails loud when the command fails', async () => {
    const { services, run, text } = setup({
      runs: { 'uvx kanvas-board': { code: 1, stdout: '', stderr: 'boom' } },
    });
    await run(proposal);
    const r = await run({ action: 'instalar', nombre: 'kanvas' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('boom');
    expect(services.read('kanvas')?.status).toBe('propuesto');
  });
});

describe('servicio servir', () => {
  const installed = async (run: (a: Record<string, unknown>) => Promise<unknown>) => {
    await run(proposal);
    await run({ action: 'instalar', nombre: 'kanvas' });
  };

  it('serves tailnet-only and reports the URL from serve status', async () => {
    const { services, calls, run, text } = setup({
      probe: true,
      runs: {
        'tailscale serve': { code: 0, stdout: 'https://pc-nico.tail1234.ts.net\n', stderr: '' },
      },
    });
    await installed(run);
    const r = await run({ action: 'servir', nombre: 'kanvas' });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain('https://pc-nico.tail1234.ts.net');
    expect(t).toContain('Tailscale en el móvil');
    expect(t).toContain('sigue sin probar');
    expect(
      calls.some(
        (c) =>
          c.cmd === 'tailscale' &&
          c.args.join(' ').includes('serve') &&
          !c.args.join(' ').includes('funnel'),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.args.join(' ').includes('funnel'))).toBe(false);
    const s = services.read('kanvas');
    expect(s?.status).toBe('servido');
    expect(s?.expose).toBe('tailnet');
  });

  it('refuses to serve when tailscale CLI is missing', async () => {
    const { services, run, text } = setup({
      probe: true,
      runs: { 'tailscale version': { code: 1, stdout: '', stderr: 'not found' } },
    });
    await installed(run);
    const r = await run({ action: 'servir', nombre: 'kanvas' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Tailscale');
    expect(services.read('kanvas')?.status).toBe('instalado');
  });
});

describe('servicio parar / listar / estado', () => {
  it('parar on a local service says it cannot do it alone', async () => {
    const { run, text } = setup({ probe: true });
    await run(proposal);
    const r = await run({ action: 'parar', nombre: 'kanvas' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('local');
  });

  it('listar shows the empty state and then the service', async () => {
    const { run, text } = setup();
    expect(text(await run({ action: 'listar' }))).toContain('No hay servicios adoptados');
    await run(proposal);
    expect(text(await run({ action: 'listar' }))).toContain('kanvas [propuesto]');
  });

  it('estado returns the rendered file with both sections', async () => {
    const { run, text } = setup();
    await run(proposal);
    const t = text(await run({ action: 'estado', nombre: 'kanvas' }));
    expect(t).toContain('## Verificado');
    expect(t).toContain('## Sin verificar');
  });
});
