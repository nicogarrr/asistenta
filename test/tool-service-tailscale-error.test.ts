// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceStore } from '../src/services/store.js';
import { type RunResult, createServiceTool, tailscaleServeFailText } from '../src/tools/service.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

const NOT_ENABLED =
  'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nXk3Fz7CNTRL\n';
const NO_DAEMON =
  'failed to connect to local tailscaled; it doesn\'t appear to be running (sudo systemctl start tailscaled ?)\nGet "http://local-tailscaled.sock/localapi/v0/status": dial unix /var/run/tailscale/tailscaled.sock: connect: no such file or directory';

/** Every call answers OK except `tailscale serve --bg …`, which answers `serve`. */
function setup(serve: RunResult) {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-tool-service-ts-'));
  dirs.push(dir);
  const tool = createServiceTool({
    services: new ServiceStore({ dir: join(dir, 'registry') }),
    servicesDir: join(dir, 'services'),
    run: async (cmd, args) =>
      cmd === 'tailscale' && args[0] === 'serve' && args.includes('--bg')
        ? serve
        : { code: 0, stdout: '', stderr: '' },
    vaultSnapshotValues: async () => [],
    probePort: async () => true,
    now: () => '2026-10-31T10:00:00.000Z',
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
};

async function serveWith(res: RunResult) {
  const { run, text } = setup(res);
  await run(proposal);
  await run({ action: 'instalar', nombre: 'kanvas' });
  const r = await run({ action: 'servir', nombre: 'kanvas' });
  return { isError: r.isError, out: text(r) };
}

describe('servicio servir: errores de Tailscale en castellano llano', () => {
  it('Serve sin activar: da el enlace para activarlo y no pega el texto en inglés', async () => {
    const { isError, out } = await serveWith({ code: 1, stdout: '', stderr: NOT_ENABLED });
    expect(isError).toBe(true);
    expect(out).toContain('no tiene activado Serve');
    expect(out).toContain('https://login.tailscale.com/f/serve?node=nXk3Fz7CNTRL');
    expect(out).not.toMatch(/is not enabled|To enable|falló/);
    expect(out).toContain('No he expuesto nada');
  });

  it('tailscaled apagado: dice que abra Tailscale, sin la ruta del socket', async () => {
    const { out } = await serveWith({ code: 1, stdout: '', stderr: NO_DAEMON });
    expect(out).toContain('Tailscale no está arrancado');
    expect(out).not.toMatch(/tailscaled\.sock|localapi|systemctl/);
  });

  it('error desconocido: no pega el texto crudo', async () => {
    const { out } = await serveWith({
      code: 1,
      stdout: '',
      stderr: 'panic: runtime error: index out of range [3] with length 3',
    });
    expect(out).toContain('no reconozco');
    expect(out).not.toMatch(/panic|runtime error/);
  });
});

describe('tailscaleServeFailText', () => {
  const t = (stderr: string) => tailscaleServeFailText({ code: 1, stdout: '', stderr });
  it('sesión cerrada', () => {
    expect(t('Logged out.\nLog in at: https://login.tailscale.com/a/abc')).toContain(
      'sesión iniciada',
    );
    expect(t('backend state NeedsLogin')).toContain('sesión iniciada');
  });
  it('permiso de operador en Linux', () => {
    expect(
      t(
        "Access denied: serve config denied\n\nUse 'sudo tailscale serve' or 'sudo tailscale set --operator=$USER'",
      ),
    ).toContain('permiso denegado');
  });
  it('tiempo agotado', () => {
    expect(t('Error: ETIMEDOUT')).toContain('tardó demasiado');
  });
  it('Serve sin enlace en el texto: explica dónde activarlo', () => {
    expect(t('error: Serve is not enabled on your tailnet')).toContain('consola de Tailscale');
  });
});
