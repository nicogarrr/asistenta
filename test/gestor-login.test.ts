/**
 * PR2 (capability 3): the vault login convention and the masked secret fill.
 * Canary discipline: every secret here is a synthetic canary (CAN4RY-*), and
 * the tests assert the canary can only ever reach the field itself - never a
 * result text, a details object, a proposal or an error message.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { missingLoginFields, normalizeDomain, parseSiteKey, siteKey } from '../src/gestor/login.js';
import { GestorStore } from '../src/gestor/store.js';
import { Gate } from '../src/permissions.js';
import { buildFillScriptMasked, createBrowserTool } from '../src/tools/browser.js';
import { createGestionTool } from '../src/tools/gestion.js';
import { clearVaultCache, vaultSet } from '../src/vault.js';

const CANARY_PASS = 'CAN4RY-s3cr3to-sintetico-nunca-real';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-login-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  clearVaultCache();
  delete process.env.PA_VAULT_BACKEND;
  delete process.env.PA_SECRETS_FILE;
});

/** Seeds the portable vault backend with the convention keys for a domain. */
async function seedVault(domain: string, fields: { username?: string; password?: string }) {
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(tmp(), 'secrets.json');
  if (fields.username !== undefined) await vaultSet(siteKey(domain, 'username'), fields.username);
  if (fields.password !== undefined) await vaultSet(siteKey(domain, 'password'), fields.password);
}

describe('convención de claves site:<dominio>:<campo>', () => {
  it('normaliza dominios desde hosts y URLs', () => {
    expect(normalizeDomain('seg-social.es')).toBe('seg-social.es');
    expect(normalizeDomain('  SEG-SOCIAL.ES  ')).toBe('seg-social.es');
    expect(normalizeDomain('www.seg-social.es')).toBe('seg-social.es');
    expect(normalizeDomain('https://www.seg-social.es/ciudadanos/login?x=1')).toBe('seg-social.es');
    expect(normalizeDomain('seg-social.es:8443')).toBe('seg-social.es');
    expect(normalizeDomain('booking.com.')).toBe('booking.com');
  });

  it('una URL con credenciales embebidas solo aporta el host', () => {
    expect(normalizeDomain('https://user:password@example.com/')).toBe('example.com');
  });

  it('rechaza lo que no puede nombrar un host', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('no soy un dominio')).toBeNull();
    expect(normalizeDomain('..')).toBeNull();
    expect(normalizeDomain('.bad')).toBeNull();
    expect(normalizeDomain('bad..name')).toBeNull();
  });

  it('siteKey/parseSiteKey hacen ida y vuelta y parseSiteKey rechaza lo demás', () => {
    expect(siteKey('seg-social.es', 'password')).toBe('site:seg-social.es:password');
    expect(parseSiteKey('site:seg-social.es:password')).toEqual({
      domain: 'seg-social.es',
      field: 'password',
    });
    expect(parseSiteKey('site:seg-social.es:usuario')).toBeNull();
    expect(parseSiteKey('site:seg-social.es')).toBeNull();
    expect(parseSiteKey('site:www.seg-social.es:password')).toBeNull();
    expect(parseSiteKey('site::password')).toBeNull();
    expect(parseSiteKey('otra:cosa:password')).toBeNull();
  });

  it('missingLoginFields nombra lo que falta, en orden canónico', () => {
    expect(missingLoginFields('x.es', [])).toEqual(['username', 'password']);
    expect(missingLoginFields('x.es', ['site:x.es:password'])).toEqual(['username']);
    expect(missingLoginFields('x.es', ['site:x.es:username', 'site:x.es:password'])).toEqual([]);
  });
});

describe('buildFillScriptMasked', () => {
  type Fake = { value: string; calls: string[] };
  function fakePage(onType: (f: Fake, t: string) => void, onFill: (f: Fake, t: string) => void) {
    const f: Fake = { value: '', calls: [] };
    const loc = {
      first: () => loc,
      fill: async (t: string) => {
        f.calls.push(`fill:${t}`);
        onFill(f, t);
      },
      click: async () => f.calls.push('click'),
      press: async (k: string) => {
        f.calls.push(`press:${k}`);
        if (k === 'Delete') f.value = '';
      },
      pressSequentially: async (t: string) => {
        f.calls.push(`type:${t}`);
        onType(f, t);
      },
      inputValue: async () => f.value,
    };
    return { f, page: { locator: () => loc, waitForTimeout: async () => {} } };
  }
  async function run(script: string, page: unknown): Promise<string> {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    return new AsyncFunction('page', script)(page);
  }

  it('rellena bien y el texto devuelto no contiene el secreto', async () => {
    const { page, f } = fakePage(
      (x, t) => {
        x.value = t;
      },
      (x, t) => {
        x.value = t;
      },
    );
    const out = await run(
      buildFillScriptMasked('page.locator("#pw").first()', '#pw', CANARY_PASS),
      page,
    );
    expect(out).toBe('filled #pw (valor del vault, no mostrado)');
    expect(f.calls).toContain(`fill:${CANARY_PASS}`); // el campo SÍ lo recibe
    expect(out).not.toContain(CANARY_PASS);
  });

  it('un campo que no coopera devuelve ATENCIÓN sin filtrar ni el valor ni lo leído', async () => {
    const { page } = fakePage(
      (x, t) => {
        x.value = `${t}-mangled`;
      },
      (x, t) => {
        x.value = `${t}-mangled`;
      },
    );
    const out = await run(
      buildFillScriptMasked('page.locator("#pw").first()', '#pw', CANARY_PASS),
      page,
    );
    expect(out).toContain('ATENCIÓN');
    expect(out).not.toContain(CANARY_PASS);
    expect(out).not.toContain('mangled');
  });
});

describe('browser fill con secret_key', () => {
  function toolWithFakeService(captured: { script?: string }) {
    const service = {
      resolveTarget: async () => ({
        ok: true,
        locatorJs: 'page.locator("#pw").first()',
        selector: '#pw',
        how: 'selector',
        visible: true,
      }),
      execJs: async (_scope: string, script: string) => {
        captured.script = script;
        return { text: 'filled #pw (valor del vault, no mostrado)' };
      },
    };
    return createBrowserTool(service as never, () => 'chat#1');
  }

  it('resuelve el secreto del vault y no lo expone en texto ni details', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const captured: { script?: string } = {};
    const tool = toolWithFakeService(captured);
    const res = await tool.execute('c1', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'site:seg-social.es:password',
    });
    expect(JSON.stringify(res.content)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).toContain('site:seg-social.es:password');
    // La frontera interna: el script que va al navegador SÍ lleva el valor.
    expect(captured.script).toContain(CANARY_PASS);
  });

  it('clave ausente: error que nombra la clave y el comando exacto, sin valor', async () => {
    await seedVault('seg-social.es', {});
    const tool = toolWithFakeService({});
    await expect(
      tool.execute('c2', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:seg-social.es:password',
      }),
    ).rejects.toThrow(/pa vault set site:seg-social\.es:password/);
  });

  it('rechaza text+secret_key a la vez y claves con mala forma', async () => {
    await seedVault('seg-social.es', {});
    const tool = toolWithFakeService({});
    await expect(
      tool.execute('c3', {
        action: 'fill',
        selector: '#pw',
        text: 'x',
        secret_key: 'site:seg-social.es:password',
      }),
    ).rejects.toThrow(/no ambos/);
    await expect(
      tool.execute('c4', { action: 'fill', selector: '#pw', secret_key: 'seg-social.es:password' }),
    ).rejects.toThrow(/site:<dominio>:<campo>/);
  });

  it('el Gate sigue preguntando por el campo de credencial (la clave nombra password)', async () => {
    let asked = 0;
    const gate = new Gate({
      dbPath: join(tmp(), 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('scope', {
      tool: 'browser',
      args: { action: 'fill', selector: '#pw', secret_key: 'site:seg-social.es:password' },
      actor: 'test',
    });
    expect(asked).toBe(1);
  });
});

describe('gestion preparar con logins', () => {
  function gestionTool(vaultNames: string[]) {
    const gestor = new GestorStore({ db: new DatabaseSync(':memory:') });
    return createGestionTool({
      gestor,
      scopeOf: () => 'scope',
      vaultNames: async () => vaultNames,
    });
  }
  const base = {
    action: 'preparar' as const,
    titulo: 'Vida laboral',
    encargo: 'descárgame la vida laboral',
    pasos: [{ texto: 'Entrar y descargar el PDF', efecto: 'lee' }],
  };

  it('la propuesta nombra claves presentes y ausentes con el comando exacto', async () => {
    const tool = gestionTool(['site:seg-social.es:username', 'site:seg-social.es:password']);
    const res = await tool.execute('g1', {
      ...base,
      logins: ['https://www.seg-social.es/ciudadanos', 'booking.com'],
    });
    const text = JSON.stringify(res.content);
    expect(text).toContain('- seg-social.es: ✔ usuario y contraseña ya están en el vault.');
    expect(text).toContain(
      '- booking.com: falta site:booking.com:username - guárdala con: pa vault set site:booking.com:username <valor>',
    );
    expect(text).toContain(
      '- booking.com: falta site:booking.com:password - guárdala con: pa vault set site:booking.com:password <valor>',
    );
    expect(text).toContain('Accesos (credenciales solo por el vault, nunca por aquí):');
  });

  it('rechaza un dominio inválido sin guardar nada', async () => {
    const tool = gestionTool([]);
    const res = await tool.execute('g2', { ...base, logins: ['no soy un dominio'] });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('no parece un dominio válido');
  });

  it('sin logins la propuesta no lleva sección de accesos', async () => {
    const tool = gestionTool([]);
    const res = await tool.execute('g3', { ...base });
    expect(JSON.stringify(res.content)).not.toContain('Accesos');
  });
});
