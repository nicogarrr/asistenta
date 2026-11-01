// FIRST import: fija PA_STATE_DIR antes de que vault.js cargue paths.ts.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que vault.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realVault } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';
import { createBrowserTool } from '../src/tools/browser.js';
import { clearVaultCache } from '../src/vault.js';

const ME = { name: 'Nico García', email: 'nico@example.com' };
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-alta-correo-'));
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

async function fillEmail(s: ReturnType<typeof setup>, email = ME.email) {
  await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
  const r = await s.browser.execute('f', {
    action: 'fill',
    selector: '#email',
    text: email,
  } as never);
  expect(s.text(r)).not.toMatch(/isError":true/);
}

describe('alta sin contraseña (enlace o código por correo): el envío también exige el sí', () => {
  it('con el correo del alta escrito y sin sí, no hace clic ni pulsa Enter', async () => {
    const s = setup();
    await fillEmail(s);
    const r = await s.click();
    expect(s.clicked).toEqual([]);
    expect(s.text(r)).toMatch(/confirmar_registro/);
    const before = s.pressed.length; // el script de fill del fake también cuenta como «.press(»
    await s.browser.execute('p', { action: 'press', selector: '#email' } as never);
    expect(s.pressed.length).toBe(before);
  });

  it('el correo con mayúsculas o espacios cuenta igual', async () => {
    const s = setup();
    await fillEmail(s, '  NICO@Example.com ');
    await s.click();
    expect(s.clicked).toEqual([]);
  });

  it('tras confirmar_registro el clic sigue', async () => {
    const s = setup();
    await fillEmail(s);
    await s.run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: ME.email });
    await s.click();
    expect(s.clicked).toEqual(['#crear']);
  });

  it('escribir el correo en otra web (con un alta pendiente en wallapop) no frena nada', async () => {
    const s = setup();
    await s.run({ action: 'preparar_registro', sitio: 'otra.es' });
    await s.browser.execute('f', { action: 'fill', selector: '#email', text: ME.email } as never);
    await s.click();
    expect(s.clicked).toEqual(['#crear']);
  });

  it('otro texto en el formulario no activa el freno', async () => {
    const s = setup();
    await s.run({ action: 'preparar_registro', sitio: 'wallapop.es' });
    await s.browser.execute('f', { action: 'fill', selector: '#n', text: ME.name } as never);
    await s.click();
    expect(s.clicked).toEqual(['#crear']);
  });
});
