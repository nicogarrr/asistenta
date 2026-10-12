// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que permissions.js/vault.js carguen paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
const CANARY_TOKEN = 'CAN4RY-token-en-url';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pa-login-'));
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
    expect(normalizeDomain(`https://user:${CANARY_TOKEN}@bad..name/`)).toBeNull();
  });

  it('rechaza lo que no puede nombrar un host', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('no soy un dominio')).toBeNull();
    expect(normalizeDomain('..')).toBeNull();
    expect(normalizeDomain('.bad')).toBeNull();
    expect(normalizeDomain('bad..name')).toBeNull();
  });

  it('siteKey/parseSiteKey hacen ida y vuelta, con forma y casing canónicos', () => {
    expect(siteKey('seg-social.es', 'password')).toBe('site:seg-social.es:password');
    expect(parseSiteKey('site:seg-social.es:password')).toEqual({
      domain: 'seg-social.es',
      field: 'password',
    });
    // El casing del argumento no desincroniza: parse devuelve lo canónico.
    expect(parseSiteKey('Site:SEG-Social.ES:Password')).toEqual({
      domain: 'seg-social.es',
      field: 'password',
    });
    expect(parseSiteKey('site:seg-social.es:usuario')).toBeNull();
    expect(parseSiteKey('site:seg-social.es')).toBeNull();
    expect(parseSiteKey('site:www.seg-social.es:password')).toBeNull();
    expect(parseSiteKey('site::password')).toBeNull();
    expect(parseSiteKey('otra:cosa:password')).toBeNull();
  });

  it('missingLoginFields es EXACTO, como vaultGet: casing distinto cuenta como ausente', () => {
    expect(missingLoginFields('x.es', [])).toEqual(['username', 'password']);
    expect(missingLoginFields('x.es', ['site:x.es:password'])).toEqual(['username']);
    expect(missingLoginFields('x.es', ['site:x.es:username', 'site:x.es:password'])).toEqual([]);
    // Una clave con casing raro existe, pero vaultGet no la encontraría: ausente.
    expect(missingLoginFields('x.es', ['Site:X.es:Password'])).toEqual(['username', 'password']);
  });
});

describe('buildFillScriptMasked', () => {
  type Fake = { value: string; calls: string[] };
  function fakePage(opts: {
    href?: string | (() => string);
    onType?: (f: Fake, t: string) => void;
    onFill?: (f: Fake, t: string) => void;
    throwOn?: Record<string, string>;
  }) {
    const f: Fake = { value: '', calls: [] };
    const maybeThrow = (op: string) => {
      const msg = opts.throwOn?.[op];
      if (msg) throw new Error(msg);
    };
    const loc = {
      first: () => loc,
      evaluate: async (fn: () => string) => {
        maybeThrow('evaluate');
        const href = typeof opts.href === 'function' ? opts.href() : (opts.href ?? '');
        void fn;
        return href;
      },
      fill: async (t: string) => {
        maybeThrow('fill');
        f.calls.push(`fill:${t}`);
        opts.onFill?.(f, t);
      },
      click: async () => {
        maybeThrow('click');
        f.calls.push('click');
      },
      press: async (k: string) => {
        maybeThrow('press');
        f.calls.push(`press:${k}`);
        if (k === 'Delete') f.value = '';
      },
      pressSequentially: async (t: string) => {
        maybeThrow('pressSequentially');
        f.calls.push(`type:${t}`);
        opts.onType?.(f, t);
      },
      inputValue: async () => {
        maybeThrow('inputValue');
        return f.value;
      },
    };
    return { f, page: { locator: () => loc, waitForTimeout: async () => {} } };
  }
  async function run(script: string, page: unknown): Promise<string> {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    return new AsyncFunction('page', script)(page);
  }
  const masked = (value = CANARY_PASS, domain = 'seg-social.es') =>
    buildFillScriptMasked('page.locator("#pw").first()', '#pw', value, domain);
  const good = {
    onType: (x: Fake, t: string) => {
      x.value = t;
    },
    onFill: (x: Fake, t: string) => {
      x.value = t;
    },
  };

  it('rellena bien en el dominio canónico (www y subdominio valen), sin exponer el secreto', async () => {
    for (const href of ['https://www.seg-social.es/login', 'https://login.seg-social.es/x?y=1']) {
      const { page, f } = fakePage({ href, ...good });
      const out = await run(masked(), page);
      expect(out).toBe('filled #pw (valor del vault, no mostrado)');
      expect(f.calls).toContain(`fill:${CANARY_PASS}`); // el campo SÍ lo recibe
      expect(out).not.toContain(CANARY_PASS);
    }
  });

  it('origen distinto, ilegible o http: RECHAZADO sin una sola pulsación', async () => {
    const cases = [
      { href: 'https://other.invalid/login' },
      { href: 'https://seg-social.es.evil.invalid/' },
      { href: 'http://seg-social.es/login' },
      { throwOn: { evaluate: ' SecurityError: cross-origin frame' } },
    ];
    for (const c of cases) {
      const { page, f } = fakePage({ href: 'https://seg-social.es/', ...good, ...c });
      const out = await run(masked(), page);
      expect(out).toContain('RECHAZADO');
      expect(out).not.toContain(CANARY_PASS);
      expect(f.calls.some((x) => x.includes(CANARY_PASS))).toBe(false);
    }
  });

  it('localhost puede ser http (desarrollo), un dominio real no', async () => {
    const { page } = fakePage({ href: 'http://localhost:8080/login', ...good });
    const out = await run(masked(CANARY_PASS, 'localhost'), page);
    expect(out).toContain('filled');
  });

  it('B1: un error de fill que cita el valor sale genérico, sin canario', async () => {
    const { page } = fakePage({
      href: 'https://seg-social.es/',
      ...good,
      throwOn: { fill: `locator.fill: Timeout 3000ms exceeded, value=${CANARY_PASS}` },
    });
    const out = await run(masked(), page);
    expect(out).toContain('no se pudo escribir o verificar');
    expect(out).not.toContain(CANARY_PASS);
    expect(out).not.toContain('Timeout');
  });

  it('B1: errores de click/press/pressSequentially en el reintento salen genéricos', async () => {
    for (const op of ['click', 'press', 'pressSequentially'] as const) {
      const { page } = fakePage({
        href: 'https://seg-social.es/',
        onFill: (x) => {
          x.value = 'wrong';
        },
        onType: (x, t) => {
          x.value = t;
        },
        throwOn: { [op]: `${op} failed on value=${CANARY_PASS}` },
      });
      const out = await run(masked(), page);
      expect(out).toContain('no se pudo reintentar o verificar');
      expect(out).not.toContain(CANARY_PASS);
      expect(out).not.toContain('failed');
    }
  });

  it('B3: una lectura imposible es "no verificado", NUNCA un filled inventado', async () => {
    const { page } = fakePage({
      href: 'https://seg-social.es/',
      ...good,
      throwOn: { inputValue: 'element is not visible' },
    });
    const out = await run(masked(), page);
    expect(out).toContain('no se pudo escribir o verificar');
    expect(out).not.toContain('filled');
    expect(out).not.toContain(CANARY_PASS);
  });

  it('B3/B1: la lectura del reintento también es honesta y genérica', async () => {
    // Primera lectura ok (wrong), la del reintento arroja.
    let reads2 = 0;
    const f3: { value: string; calls: string[] } = { value: '', calls: [] };
    const loc3 = {
      first: () => loc3,
      evaluate: async () => 'https://seg-social.es/',
      fill: async (t: string) => {
        f3.value = t === '' ? '' : 'wrong';
      },
      click: async () => {},
      press: async () => {},
      pressSequentially: async (t: string) => {
        f3.value = t;
      },
      inputValue: async () => {
        reads2++;
        if (reads2 === 2) throw new Error('detached frame');
        return f3.value;
      },
    };
    const page3 = { locator: () => loc3, waitForTimeout: async () => {} };
    const out = await run(masked(), page3);
    expect(out).toContain('no se pudo reintentar o verificar');
    expect(out).not.toContain('filled');
    expect(out).not.toContain(CANARY_PASS);
  });

  it('navegación a mitad de fill: el segundo chequeo de origen frena el reintento', async () => {
    let navigated = false;
    const { page, f } = fakePage({
      href: () => (navigated ? 'https://evil.invalid/' : 'https://seg-social.es/'),
      onFill: (x) => {
        x.value = 'wrong';
        navigated = true; // la página cambia tras el primer fill
      },
      onType: (x, t) => {
        x.value = t;
      },
    });
    const out = await run(masked(), page);
    expect(out).toContain('RECHAZADO');
    expect(f.calls.some((x) => x.startsWith('type:'))).toBe(false);
  });

  it('doble mismatch: ATENCIÓN final sin valor ni lo leído', async () => {
    const { page } = fakePage({
      href: 'https://seg-social.es/',
      onFill: (x, t) => {
        x.value = `${t}-mangled`;
      },
      onType: (x, t) => {
        x.value = `${t}-mangled`;
      },
    });
    const out = await run(masked(), page);
    expect(out).toContain('ATENCIÓN');
    expect(out).not.toContain(CANARY_PASS);
    expect(out).not.toContain('mangled');
  });
});

describe('browser fill con secret_key', () => {
  function toolWithFakeService(opts: {
    pageUrl?: string;
    fillText?: string;
    fillThrows?: string;
    captured?: { script?: string };
  }) {
    const service = {
      resolveTarget: async () => ({
        ok: true,
        locatorJs: 'page.locator("#pw").first()',
        selector: '#pw',
        how: 'selector',
        visible: true,
      }),
      execJs: async (_scope: string, script: string) => {
        if (script.includes('page.url()')) {
          return { text: opts.pageUrl ?? 'https://seg-social.es/login', console: [] };
        }
        if (opts.captured) opts.captured.script = script;
        if (opts.fillThrows) throw new Error(opts.fillThrows);
        return {
          text: opts.fillText ?? 'filled #pw (valor del vault, no mostrado)',
          console: [],
        };
      },
    };
    return createBrowserTool(service as never, () => 'chat#1');
  }

  it('resuelve el secreto del vault y no lo expone en texto ni details', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const captured: { script?: string } = {};
    const tool = toolWithFakeService({ captured });
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

  it('B2: página en otro origen -> rechazo ANTES de tocar el vault o teclear', async () => {
    await seedVault('example.com', { password: CANARY_PASS });
    const captured: { script?: string } = {};
    const tool = toolWithFakeService({ pageUrl: 'https://other.invalid/login', captured });
    await expect(
      tool.execute('c2', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:example.com:password',
      }),
    ).rejects.toThrow(/la página actual no es example\.com/);
    expect(captured.script).toBeUndefined(); // jamás se construyó el script
  });

  it('B2: subdominio del dominio canónico sí vale; dominio trampolín no', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const ok = toolWithFakeService({ pageUrl: 'https://login.seg-social.es/x', captured: {} });
    const res = await ok.execute('c3', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'site:seg-social.es:password',
    });
    expect(res.isError).toBeFalsy();
    const evil = toolWithFakeService({
      pageUrl: 'https://seg-social.es.evil.invalid/',
      captured: {},
    });
    await expect(
      evil.execute('c4', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:seg-social.es:password',
      }),
    ).rejects.toThrow(/no es seg-social\.es/);
  });

  it('clave con casing raro se canonicaliza antes de vaultGet', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const captured: { script?: string } = {};
    const tool = toolWithFakeService({ captured });
    const res = await tool.execute('c5', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'Site:SEG-Social.ES:Password',
    });
    expect(JSON.stringify(res.details)).toContain('site:seg-social.es:password');
    expect(captured.script).toContain(CANARY_PASS);
  });

  it('B1: un execJs que arroja citando el valor sale como error genérico', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const tool = toolWithFakeService({ fillThrows: `locator.fill: value=${CANARY_PASS}` });
    await expect(
      tool.execute('c6', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:seg-social.es:password',
      }),
    ).rejects.toThrow(/No se pudo escribir el secreto/);
    try {
      await tool.execute('c6b', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:seg-social.es:password',
      });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(CANARY_PASS);
    }
  });

  it('B1: un texto devuelto que contuviera el valor se sustituye entero', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const tool = toolWithFakeService({ fillText: `oops ${CANARY_PASS}` });
    const res = await tool.execute('c7', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'site:seg-social.es:password',
    });
    expect(JSON.stringify(res.content)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.content)).toContain('no se pudo verificar');
  });

  it('clave ausente: error que nombra la clave y el comando exacto, sin valor', async () => {
    await seedVault('seg-social.es', {});
    const tool = toolWithFakeService({});
    await expect(
      tool.execute('c8', {
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
      tool.execute('c9', {
        action: 'fill',
        selector: '#pw',
        text: 'x',
        secret_key: 'site:seg-social.es:password',
      }),
    ).rejects.toThrow(/no ambos/);
    await expect(
      tool.execute('c10', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'seg-social.es:password',
      }),
    ).rejects.toThrow(/site:<dominio>:<campo>/);
  });

  it('el Gate pregunta por CUALQUIER secret_key, username incluido, bajo fullControl y sin memo', async () => {
    let asked = 0;
    const gate = new Gate({
      dbPath: join(tmp(), 'g.db'),
      grantWindowMs: 0,
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const call = {
      tool: 'browser',
      args: { action: 'fill', selector: '#user', secret_key: 'site:seg-social.es:username' },
      actor: 'test',
    };
    await gate.check('scope', call);
    expect(asked).toBe(1);
    // La memo del Gate cubre la repetición EXACTA aprobada (semántica
    // preexistente para cualquier credencial), pero otra clave vuelve a
    // preguntar.
    await gate.check('scope', call);
    expect(asked).toBe(1);
    await gate.check('scope', {
      tool: 'browser',
      args: { action: 'fill', selector: '#user', secret_key: 'site:booking.com:username' },
      actor: 'test',
    });
    expect(asked).toBe(2);
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
  });

  it('consistencia de casing: una clave mal guardada cuenta como ausente', async () => {
    const tool = gestionTool(['Site:Booking.com:Password']);
    const res = await tool.execute('g1b', { ...base, logins: ['booking.com'] });
    const text = JSON.stringify(res.content);
    expect(text).toContain('falta site:booking.com:password');
  });

  it('B4: dominio inválido con userinfo -> error por índice, sin repetir el input', async () => {
    const tool = gestionTool([]);
    const res = await tool.execute('g2', {
      ...base,
      logins: [`https://user:${CANARY_TOKEN}@bad..name/`],
    });
    const text = JSON.stringify(res.content);
    expect(res.isError).toBe(true);
    expect(text).toContain('login número 1');
    expect(text).not.toContain(CANARY_TOKEN);
    expect(text).not.toContain('user@');
  });

  it('sin logins la propuesta no lleva sección de accesos', async () => {
    const tool = gestionTool([]);
    const res = await tool.execute('g3', { ...base });
    expect(JSON.stringify(res.content)).not.toContain('Accesos');
  });
});
