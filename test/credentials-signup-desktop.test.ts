// FIRST import: fija PA_STATE_DIR antes de que vault.js cargue paths.ts.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { resetDesktopSignup } from '../src/credentials/signup-guard.js';
import { realVault } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';
import { createBrowserTool } from '../src/tools/browser.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';
import { clearVaultCache } from '../src/vault.js';

const ME = { name: 'Nico García', email: 'nico@example.com' };
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-alta-escritorio-'));
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(dir, 'secrets.json');
  resetDesktopSignup();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearVaultCache();
  resetDesktopSignup();
  delete process.env.PA_VAULT_BACKEND;
  delete process.env.PA_SECRETS_FILE;
});

function setup() {
  const calls: string[] = [];
  const shot = () => ({
    image: Buffer.from('frame'),
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    nativeWidth: 1920,
    nativeHeight: 1080,
  });
  const backend = {
    screenshot: async () => shot(),
    click: async (x: number, y: number) => void calls.push(`click:${x},${y}`),
    move: async () => undefined,
    drag: async () => undefined,
    type: async (text: string) => void calls.push(`type:${text}`),
    key: async (key: string) => void calls.push(`key:${key}`),
    screenSize: async () => ({ width: 1920, height: 1080 }),
  } as unknown as ScreenBackend;
  const config = {
    screenshotMaxEdge: 1920,
    screenshotQuality: 80,
    verifyActions: false,
    verifySettleMs: 1,
  } as unknown as Config;
  const allow = () => ({ verdict: 'allow' as const, reason: '' });
  const computer = createComputerTool(config, backend, allow);
  const pc = (args: Record<string, unknown>) =>
    computer.execute('pc', args as never).then(
      (r) => JSON.stringify(r),
      (e: unknown) => String(e),
    );
  const cuentas = createAccountsTool(realVault, async () => ME);
  const run = (args: Record<string, unknown>) => cuentas.execute('c', args as never);
  const service = {
    currentUrl: () => 'https://www.wallapop.es/signup',
    execJs: async () => ({ text: 'filled', console: [] }),
    describeTarget: async () => '',
    describeContext: async () => '',
    summarisePage: async () => '',
    resolveTarget: async () => ({
      ok: true,
      locatorJs: 'x',
      selector: '#x',
      how: 'selector',
      visible: true,
    }),
  };
  const browser = createBrowserTool(service as never, () => 'chat#1');
  return { calls, pc, run, browser };
}

describe('alta pendiente: el escritorio tampoco hace clic ni Enter sin el sí', () => {
  it('correo del alta escrito con el navegador → el clic del escritorio no sale', async () => {
    const s = setup();
    await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
    await s.browser.execute('f', { action: 'fill', selector: '#e', text: ME.email } as never);
    const r = await s.pc({ action: 'click', x: 10, y: 10 });
    expect(r).toMatch(/confirmar_registro/);
    expect(s.calls).toEqual([]);
  });

  it('correo tecleado en el escritorio y Enter en el mismo batch → nada se ejecuta', async () => {
    const s = setup();
    await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
    const r = await s.pc({
      action: 'batch',
      actions: [
        { action: 'type', text: ME.email },
        { action: 'key', key: 'Return' },
      ],
    });
    expect(r).toMatch(/confirmar_registro/);
    expect(s.calls).toEqual([]);
    await s.pc({ action: 'type', text: 'x\n' });
    expect(s.calls).toEqual([]);
  });

  it('tras confirmar_registro el clic del escritorio sigue', async () => {
    const s = setup();
    await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
    await s.pc({ action: 'type', text: ME.email });
    await s.run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: ME.email });
    await s.pc({ action: 'click', x: 10, y: 10 });
    expect(s.calls).toEqual([`type:${ME.email}`, 'click:10,10']);
  });

  it('sin alta escrita, el escritorio funciona como siempre', async () => {
    const s = setup();
    await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
    await s.pc({ action: 'type', text: 'hola' });
    await s.pc({ action: 'click', x: 10, y: 10 });
    await s.pc({ action: 'key', key: 'Return' });
    expect(s.calls).toEqual(['type:hola', 'click:10,10', 'key:Return']);
  });
});
