// FIRST import: fija PA_STATE_DIR antes de que vault.js cargue paths.ts.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNUP_APPROVAL_TTL_MS } from '../src/credentials/signup-guard.js';
import { realVault } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';
import { createBrowserTool } from '../src/tools/browser.js';
import { clearVaultCache } from '../src/vault.js';

const ME = { name: 'Nico García', email: 'nico@example.com' };
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-alta-clic-'));
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(dir, 'secrets.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  clearVaultCache();
  delete process.env.PA_VAULT_BACKEND;
  delete process.env.PA_SECRETS_FILE;
});

function setup(scope = 'chat#1') {
  const clicked: string[] = [];
  const pressed: string[] = [];
  const service = {
    describeTarget: async () => 'button «Crear cuenta»',
    describeContext: async () => '',
    summarisePage: async () => '',
    currentUrl: () => 'https://www.wallapop.es/signup',
    resolveTarget: async () => ({
      ok: true,
      locatorJs: 'page.locator("#x").first()',
      selector: '#x',
      how: 'selector',
      visible: true,
    }),
    execJs: async (_s: string, script: string) => {
      if (script.includes('page.url()'))
        return { text: 'https://www.wallapop.es/signup', console: [] };
      if (script.includes('.press(')) {
        pressed.push('Enter');
        return { text: 'pressed', console: [] };
      }
      return { text: 'filled', console: [] };
    },
    clickTarget: async (_s: string, sel: string) => {
      clicked.push(sel);
      throw new Error('stop-after-click');
    },
  };
  let current = scope;
  const browser = createBrowserTool(service as never, () => current);
  const cuentas = createAccountsTool(realVault, async () => ME);
  const run = (args: Record<string, unknown>) => cuentas.execute('c', args as never);
  const click = (sel = '#crear') =>
    browser.execute('b', { action: 'click', selector: sel } as never).catch(() => null);
  const text = (r: unknown) => JSON.stringify(r);
  return {
    browser,
    run,
    click,
    text,
    clicked,
    pressed,
    setScope: (s: string) => {
      current = s;
    },
  };
}

async function fillPassword(s: ReturnType<typeof setup>) {
  await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
  const r = await s.browser.execute('f', {
    action: 'fill',
    selector: '#pw',
    secret_key: 'site:wallapop.es:password',
  } as never);
  expect(s.text(r)).not.toMatch(/isError":true/);
}

describe('alta de cuenta: el clic de «crear cuenta» exige el sí fresco de confirmar_registro', () => {
  it('con la contraseña del alta escrita y sin sí, no hace clic ni pulsa Enter', async () => {
    const s = setup();
    await fillPassword(s);
    const r = await s.click();
    expect(s.clicked).toEqual([]);
    expect(s.text(r)).toMatch(/falta el sí del dueño/);
    expect(s.text(r)).toMatch(/confirmar_registro/);
    await s.browser.execute('p', { action: 'press', selector: '#pw' } as never);
    expect(s.pressed).toEqual([]);
  });

  it('tras confirmar_registro (aprobado por la Gate) el clic sigue', async () => {
    const s = setup();
    await fillPassword(s);
    await s.run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: ME.email });
    await s.click();
    expect(s.clicked).toEqual(['#crear']);
  });

  it('un sí de hace más de 10 minutos ya no vale', async () => {
    const s = setup();
    await fillPassword(s);
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await s.run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: ME.email });
    now.mockReturnValue(t0 + SIGNUP_APPROVAL_TTL_MS + 1000);
    await s.click();
    expect(s.clicked).toEqual([]);
  });

  it('un sí dado para otro correo no vale (alta preparada de nuevo con otro)', async () => {
    const s = setup();
    await fillPassword(s);
    await s.run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: ME.email });
    // La pendiente se rehace con otro correo: el sí anterior no la cubre.
    const meta = JSON.parse((await realVault.get('cuenta:wallapop.es')) ?? '{}');
    await realVault.set('site:wallapop.es:username', 'otro@example.com');
    await realVault.set('cuenta:wallapop.es', JSON.stringify(meta));
    await s.click();
    expect(s.clicked).toEqual([]);
  });

  it('sin alta en marcha, o en otra sesión sin la contraseña, el navegador no cambia', async () => {
    const s = setup();
    await s.click('#cookies');
    expect(s.clicked).toEqual(['#cookies']);
    await fillPassword(s);
    s.setScope('chat#2');
    await s.click('#otro');
    expect(s.clicked).toEqual(['#cookies', '#otro']);
  });

  it('al descartar el alta, los clics vuelven a funcionar', async () => {
    const s = setup();
    await fillPassword(s);
    await s.run({ action: 'descartar', sitio: 'wallapop.es' });
    await s.click();
    expect(s.clicked).toEqual(['#crear']);
  });
});
