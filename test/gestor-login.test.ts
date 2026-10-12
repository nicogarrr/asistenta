// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que permissions.js/vault.js carguen paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { missingLoginFields, normalizeDomain, parseSiteKey, siteKey } from '../src/gestor/login.js';
import { PlaybookStore } from '../src/gestor/playbooks.js';
import { GestorStore } from '../src/gestor/store.js';
import { Gate } from '../src/permissions.js';
import {
  SECRET_FILL_STATUSES,
  buildFillScriptMasked,
  createBrowserTool,
  secretFillMessage,
  secretFillOk,
} from '../src/tools/browser.js';
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

describe('buildFillScriptMasked (protocolo de tokens)', () => {
  /**
   * El script corre en el vm REAL del BrowserService: contexto vacío con
   * codeGeneration deshabilitado y solo page/state/console inyectados - NO
   * hay URL, ni Function, ni globals del host. Un AsyncFunction heredaría
   * los globals del host y ocultaría su ausencia (eso enmascaró el bug de
   * `new URL` en R1).
   */
  async function runInVm(script: string, page: unknown): Promise<string> {
    const context = vm.createContext(
      {},
      { codeGeneration: { strings: false, wasm: false } },
    ) as Record<string, unknown>;
    context.page = page;
    context.state = {};
    context.console = { log: () => {} };
    const compiled = new vm.Script(`(async () => {\n${script}\n})()`);
    return (await compiled.runInContext(context)) as string;
  }

  type Fake = { value: string; calls: string[] };
  function fakeSecretPage(opts: {
    href?: string | (() => string);
    onType?: (f: Fake, t: string) => void;
    onFill?: (f: Fake, t: string) => void;
    throwOn?: Record<string, string>;
    detachBeforeFill?: boolean;
  }) {
    const f: Fake = { value: '', calls: [] };
    const hrefOf = () =>
      typeof opts.href === 'function' ? opts.href() : (opts.href ?? 'https://seg-social.es/');
    const maybeThrow = (op: string) => {
      const msg = opts.throwOn?.[op];
      if (msg) throw new Error(msg);
    };
    const el = {
      evaluate: async (fn: unknown) => {
        maybeThrow('evaluate');
        // El script usa evaluate para el origen (location.href) y para leer el
        // valor; el doble distingue por el source de la función.
        if (String(fn).includes('location.href')) return hrefOf();
        maybeThrow('readvalue');
        return f.value;
      },
      fill: async (t: string) => {
        maybeThrow('fill');
        if (opts.detachBeforeFill) {
          // Navegación justo tras el chequeo: el handle queda detached y
          // Playwright arroja - el secreto NO se escribe en el nuevo frame.
          throw new Error('Target closed (frame navigated)');
        }
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
      type: async (t: string) => {
        maybeThrow('type');
        f.calls.push(`type:${t}`);
        opts.onType?.(f, t);
      },
    };
    const loc = {
      first: () => loc,
      elementHandle: async () => {
        maybeThrow('elementHandle');
        return el;
      },
    };
    return { f, page: { locator: () => loc, waitForTimeout: async () => {} } };
  }
  const masked = (value = CANARY_PASS, domain = 'seg-social.es') =>
    buildFillScriptMasked('page.locator("#pw").first()', value, domain);
  const good = {
    onType: (x: Fake, t: string) => {
      x.value = t;
    },
    onFill: (x: Fake, t: string) => {
      x.value = t;
    },
  };

  it('corre en un vm SIN URL ni globals del host y rellena en el dominio canónico', async () => {
    for (const href of [
      'https://seg-social.es/login',
      'https://www.seg-social.es/login',
      'https://login.seg-social.es/x?y=1',
    ]) {
      const { page, f } = fakeSecretPage({ href, ...good });
      const out = await runInVm(masked(), page);
      expect(out).toBe('filled');
      expect(f.calls).toContain(`fill:${CANARY_PASS}`); // el campo SÍ lo recibe
      expect(out).not.toContain(CANARY_PASS);
    }
  });

  it('www con punto escapado: wwwxexample.com y www-example.com NO son example.com', async () => {
    for (const href of ['https://wwwxexample.com/', 'https://www-example.com/']) {
      const { page, f } = fakeSecretPage({ href, ...good });
      const out = await runInVm(masked(CANARY_PASS, 'example.com'), page);
      expect(out).toBe('rejected_origin');
      expect(f.calls.some((x) => x.includes(CANARY_PASS))).toBe(false);
    }
    const { page } = fakeSecretPage({ href: 'https://www.example.com/', ...good });
    expect(await runInVm(masked(CANARY_PASS, 'example.com'), page)).toBe('filled');
  });

  it('origen distinto, ilegible o http: rejected_origin sin una sola pulsación', async () => {
    const cases = [
      { href: 'https://other.invalid/login' },
      { href: 'https://seg-social.es.evil.invalid/' },
      { href: 'http://seg-social.es/login' },
      { throwOn: { evaluate: 'SecurityError: cross-origin frame' } },
    ];
    for (const c of cases) {
      const { page, f } = fakeSecretPage({ href: 'https://seg-social.es/', ...good, ...c });
      const out = await runInVm(masked(), page);
      expect(out).toBe('rejected_origin');
      expect(f.calls.some((x) => x.includes(CANARY_PASS))).toBe(false);
    }
  });

  it('localhost puede ser http (desarrollo)', async () => {
    const { page } = fakeSecretPage({ href: 'http://localhost:8080/login', ...good });
    expect(await runInVm(masked(CANARY_PASS, 'localhost'), page)).toBe('filled');
  });

  it('un error de fill que cita el valor devuelve token genérico', async () => {
    const { page } = fakeSecretPage({
      href: 'https://seg-social.es/',
      ...good,
      throwOn: { fill: `locator.fill: Timeout 3000ms exceeded, value=${CANARY_PASS}` },
    });
    const out = await runInVm(masked(), page);
    expect(out).toBe('error_write');
    expect(out).not.toContain(CANARY_PASS);
    expect(out).not.toContain('Timeout');
  });

  it('SIN reintento por teclado: un fill inexacto es mismatch y NUNCA se teclea', async () => {
    // B2 residual (R3): el.type no es atómico - el foco puede cambiar a mitad
    // y los caracteres restantes irían al nuevo destino. El canal de secretos
    // no reintenta con el teclado: fill exacto o nada, y mismatch va a humano.
    const { page, f } = fakeSecretPage({
      href: 'https://seg-social.es/',
      onFill: (x) => {
        x.value = 'wrong';
      },
      onType: (x, t) => {
        x.value = t;
      },
    });
    const out = await runInVm(masked(), page);
    expect(out).toBe('mismatch');
    expect(f.calls.some((x) => x.startsWith('type:'))).toBe(false);
    expect(f.calls.some((x) => x === 'click')).toBe(false);
    expect(f.calls.some((x) => x.startsWith('press:'))).toBe(false);
  });

  it('lectura imposible es error_verify/error_write, NUNCA un filled inventado', async () => {
    // Campo no-input: el read-back devuelve null.
    const { page } = fakeSecretPage({
      href: 'https://seg-social.es/',
      onFill: () => {},
      onType: () => {},
    });
    (page as never as { locator: () => unknown }).locator = () => {
      const el = {
        evaluate: async (fn: unknown) => {
          if (String(fn).includes('location.href')) return 'https://seg-social.es/';
          return null; // no es un input
        },
        fill: async () => {},
        click: async () => {},
        press: async () => {},
        type: async () => {},
      };
      const locObj = { first: (): unknown => locObj, elementHandle: async () => el };
      return locObj;
    };
    expect(await runInVm(masked(), page)).toBe('error_verify');
    // Read-back que arroja tras escribir: se intentó escribir y no se pudo verificar.
    const { page: page2 } = fakeSecretPage({
      href: 'https://seg-social.es/',
      ...good,
      throwOn: { readvalue: 'detached frame' },
    });
    expect(await runInVm(masked(), page2)).toBe('error_verify');
  });

  it('TOCTOU: swap de frame JUSTO entre evaluate y fill aborta sin escribir', async () => {
    const { page, f } = fakeSecretPage({
      href: 'https://seg-social.es/',
      ...good,
      detachBeforeFill: true,
    });
    const out = await runInVm(masked(), page);
    expect(out).toBe('error_write');
    expect(f.calls.some((x) => x.includes(CANARY_PASS))).toBe(false);
  });

  it('B3: origen cambia TRAS escritura confirmada -> aborted_after_write, no rejected_origin', async () => {
    // Repro determinista de la R3: el primer fill escribe el canario en el
    // origen bueno (typed=1) y el origen cambia antes de la verificación. El
    // token debe admitir el intento de escritura, no prometer que no se
    // escribió nada.
    let swapped = false;
    const { page, f } = fakeSecretPage({
      href: () => (swapped ? 'https://evil.invalid/' : 'https://seg-social.es/'),
      onFill: (x, t) => {
        x.value = t; // escritura confirmada
        swapped = true;
      },
    });
    const out = await runInVm(masked(), page);
    expect(out).toBe('aborted_after_write');
    expect(f.calls).toContain(`fill:${CANARY_PASS}`); // hubo intento real
    expect(f.calls.some((x) => x.startsWith('type:'))).toBe(false);
  });

  it('mismatch: token mismatch, sin valor ni lo leído', async () => {
    const { page, f } = fakeSecretPage({
      href: 'https://seg-social.es/',
      onFill: (x, t) => {
        x.value = `${t}-mangled`;
      },
    });
    const out = await runInVm(masked(), page);
    expect(out).toBe('mismatch');
    expect(out).not.toContain(CANARY_PASS);
    expect(out).not.toContain('mangled');
    expect(f.calls.some((x) => x.startsWith('type:'))).toBe(false);
  });

  it('secretFillOk solo acepta el token de éxito', () => {
    expect(secretFillOk('filled')).toBe(true);
    for (const bad of [
      'mismatch',
      'rejected_origin',
      'aborted_after_write',
      'error_write',
      'error_verify',
      'filled CAN4RY',
      '',
    ]) {
      expect(secretFillOk(bad)).toBe(false);
    }
  });

  it('mensajes honestos: rechazo antes de escribir vs aborto tras intento', () => {
    // B3 (R3): rejected_origin promete que no se escribió nada (es pre-write);
    // aborted_after_write admite el intento y no promete ausencia de divulgación.
    expect(secretFillMessage('rejected_origin', 'seg-social.es')).toContain(
      'No se ha escrito nada',
    );
    const aborted = secretFillMessage('aborted_after_write', 'seg-social.es');
    expect(aborted).not.toContain('No se ha escrito nada');
    expect(aborted).toContain('se intentó escribir');
    expect(aborted).toContain('texto parcial');
    expect(secretFillMessage('error_verify', 'seg-social.es')).toContain('se intentó escribir');
    for (const st of SECRET_FILL_STATUSES) {
      expect(secretFillMessage(st, 'seg-social.es')).not.toContain('CAN4RY');
    }
  });
});

describe('browser fill con secret_key', () => {
  function toolWithFakeService(opts: {
    pageUrl?: string;
    fillText?: string;
    fillThrows?: string;
    captured?: { script?: string };
    resolveFail?: boolean;
  }) {
    const service = {
      resolveTarget: async () =>
        opts.resolveFail
          ? {
              ok: false,
              how: 'missing',
              visible: false,
              error: `page-derived ${CANARY_PASS}`,
              content: `leak ${CANARY_PASS}`,
            }
          : {
              ok: true,
              locatorJs: 'page.locator("#pw").first()',
              selector: '#pw',
              how: 'selector',
              visible: true,
            },
      execJs: async (_scope: string, script: string) => {
        if (script.includes('page.url()')) {
          return { text: opts.pageUrl ?? 'https://seg-social.es/login', console: [] };
        }
        if (opts.captured) opts.captured.script = script;
        if (opts.fillThrows) throw new Error(opts.fillThrows);
        return { text: opts.fillText ?? 'filled', console: [] };
      },
    };
    return createBrowserTool(service as never, () => 'chat#1');
  }

  it('resuelve el secreto del vault y devuelve SOLO mensaje fijo + details allowlist', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const captured: { script?: string } = {};
    const tool = toolWithFakeService({ captured });
    const res = await tool.execute('c1', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'site:seg-social.es:password',
    });
    expect(JSON.stringify(res.content)).toContain('Campo rellenado con el valor del vault');
    expect(JSON.stringify(res.content)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).not.toContain(CANARY_PASS);
    expect(res.details).toMatchObject({
      secret_key: 'site:seg-social.es:password',
      status: 'filled',
      visible: true,
      resolvedAs: 'selector',
    });
    // Allowlist: nada de locatorJs/selector/internals en details.
    expect(JSON.stringify(res.details)).not.toContain('locatorJs');
    // La frontera interna: el script que va al navegador SÍ lleva el valor.
    expect(captured.script).toContain(CANARY_PASS);
  });

  it('rama sin resolución: salida genérica también, nada de resolved cruza', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const tool = toolWithFakeService({ resolveFail: true });
    const res = await tool.execute('c1z', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'site:seg-social.es:password',
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).not.toContain('locatorJs');
    expect(JSON.stringify(res.content)).toContain('No se encontró el campo');
  });

  it('B1: fragmento parcial o JSON-escaped del valor en la salida no atraviesa', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    for (const dirty of [
      `filled ${CANARY_PASS.slice(0, 9)}`, // fragmento parcial
      `filled ${JSON.stringify(CANARY_PASS).slice(1, 14)}`, // JSON-escaped
      `filled\u0041${CANARY_PASS.slice(0, 6)}`, // mezcla con escape
    ]) {
      const tool = toolWithFakeService({ fillText: dirty });
      const res = await tool.execute('c1x', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:seg-social.es:password',
      });
      // Token desconocido -> mensaje genérico fijo, isError, cero canario.
      expect(JSON.stringify(res.content)).not.toContain('CAN4RY');
      expect(JSON.stringify(res.details)).not.toContain('CAN4RY');
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('no se pudo verificar');
    }
  });

  it('B1: un selector contaminado no puede arrastrar el secreto al mensaje', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const tool = toolWithFakeService({});
    const res = await tool.execute('c1y', {
      action: 'fill',
      selector: `#pw-${CANARY_PASS}`,
      secret_key: 'site:seg-social.es:password',
    });
    expect(JSON.stringify(res.content)).not.toContain(CANARY_PASS);
    expect(JSON.stringify(res.details)).not.toContain(CANARY_PASS);
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

  it('un execJs que arroja citando el valor sale como error genérico', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const tool = toolWithFakeService({ fillThrows: `locator.fill: value=${CANARY_PASS}` });
    try {
      await tool.execute('c6', {
        action: 'fill',
        selector: '#pw',
        secret_key: 'site:seg-social.es:password',
      });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toContain('No se pudo escribir el secreto');
      expect(String(err)).not.toContain(CANARY_PASS);
    }
  });

  it('status de error del protocolo -> isError con mensaje fijo', async () => {
    await seedVault('seg-social.es', { password: CANARY_PASS });
    const tool = toolWithFakeService({ fillText: 'rejected_origin' });
    const res = await tool.execute('c6z', {
      action: 'fill',
      selector: '#pw',
      secret_key: 'site:seg-social.es:password',
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('RECHAZADO');
    expect(JSON.stringify(res.content)).not.toContain(CANARY_PASS);
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

  it('el Gate pregunta por CUALQUIER secret_key, username incluido, bajo fullControl', async () => {
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
      playbooks: new PlaybookStore({ dir: tmp() }),
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
