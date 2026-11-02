import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cdpEndpoint,
  chromeArgs,
  chromeCandidates,
  ensureChromeDebugPort,
  findChrome,
} from '../src/browser/chrome-cdp.js';
import { BrowserService, ownerBrowserProfileKey } from '../src/browser/service.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Chrome del dueño por CDP: arranque y seguridad del puerto', () => {
  it('el puerto solo escucha en 127.0.0.1 y se rechazan puertos raros', () => {
    expect(cdpEndpoint(9222)).toBe('http://127.0.0.1:9222');
    expect(() => cdpEndpoint(0)).toThrow(/no válido/);
    expect(() => cdpEndpoint(80)).toThrow(/no válido/);
    expect(() => cdpEndpoint(70000)).toThrow(/no válido/);
    const args = chromeArgs('C:\\perfil', 9222);
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--user-data-dir=C:\\perfil');
    expect(args.join(' ')).not.toMatch(/0\.0\.0\.0/);
  });

  it('busca Chrome en las rutas de cada sistema', () => {
    const env = { PROGRAMFILES: 'C:\\PF', LOCALAPPDATA: 'C:\\L' };
    expect(chromeCandidates('win32', env)[0]).toMatch(/PF.*Chrome.*chrome\.exe$/);
    expect(chromeCandidates('darwin')[0]).toContain('Google Chrome.app');
    expect(findChrome('linux', (p) => p === '/usr/bin/google-chrome-stable')).toBe(
      '/usr/bin/google-chrome-stable',
    );
    expect(findChrome('linux', () => false)).toBeNull();
  });

  it('si ya hay un Chrome con el puerto, lo usa y no abre otro', async () => {
    const launch = vi.fn();
    const url = await ensureChromeDebugPort('/p', 9222, {
      fetchVersion: async () => true,
      launch,
    });
    expect(url).toBe('http://127.0.0.1:9222');
    expect(launch).not.toHaveBeenCalled();
  });

  it('si está cerrado, lo abre con su perfil y espera al puerto', async () => {
    let vivo = false;
    const launch = vi.fn(() => {
      vivo = true;
    });
    await ensureChromeDebugPort('/perfil', 9222, {
      fetchVersion: async () => vivo,
      find: () => '/usr/bin/google-chrome',
      launch,
      sleep: async () => undefined,
    });
    expect(launch).toHaveBeenCalledWith(
      '/usr/bin/google-chrome',
      expect.arrayContaining(['--user-data-dir=/perfil', '--remote-debugging-address=127.0.0.1']),
    );
  });

  it('avisa en una línea si no hay Chrome o no responde', async () => {
    await expect(
      ensureChromeDebugPort('/p', 9222, { fetchVersion: async () => false, find: () => null }),
    ).rejects.toThrow('No encuentro Chrome instalado');
    await expect(
      ensureChromeDebugPort('/p', 9222, {
        fetchVersion: async () => false,
        find: () => '/x/chrome',
        launch: () => undefined,
        sleep: async () => undefined,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/no respondió en el puerto 9222/);
  });
});

describe('Chrome del dueño por CDP: la sesión se engancha y se suelta sin cerrar Chrome', () => {
  it('un hilo del dueño se conecta por CDP; cerrar suelta la conexión, no mata Chrome', async () => {
    const { chromium } = await import('playwright');
    const page = new Proxy(
      { isClosed: () => false },
      {
        get: (t, k) =>
          k in t ? (t as never)[k] : k === 'then' ? undefined : () => Promise.resolve(undefined),
      },
    );
    const contextClose = vi.fn(async () => undefined);
    const context = {
      pages: () => [page],
      newPage: async () => page,
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      close: contextClose,
      route: async () => undefined,
      on: () => undefined,
      addInitScript: async () => undefined,
      exposeFunction: async () => undefined,
    };
    const browserClose = vi.fn(async () => undefined);
    const conectar = vi
      .spyOn(chromium, 'connectOverCDP')
      .mockResolvedValue({ contexts: () => [context], close: browserClose } as never);
    const lanzar = vi.spyOn(chromium, 'launchPersistentContext');
    const root = mkdtempSync(join(tmpdir(), 'pa-cdp-'));
    tmp.push(root);
    const servicio = new BrowserService({
      profilesDir: root,
      policy: {
        autoApprove: true,
        allowPrivateHosts: true,
        adSkipIntervalMs: 0,
        approve: async () => true,
      },
      sharedProfileKey: (scope) => ownerBrowserProfileKey(scope, 42),
      cdpPort: 9222,
      cdpDeps: { fetchVersion: async () => true },
    });
    try {
      await servicio.open('telegram:dm:42#main', 'http://example.com/').catch(() => undefined);
      expect(conectar).toHaveBeenCalledWith('http://127.0.0.1:9222', expect.anything());
      expect(lanzar).not.toHaveBeenCalled();
      expect(servicio.isOpen('telegram:dm:42#main')).toBe(true);
      await servicio.close('telegram:dm:42#main');
      expect(browserClose).toHaveBeenCalledTimes(1);
      expect(contextClose).not.toHaveBeenCalled();
    } finally {
      conectar.mockRestore();
      lanzar.mockRestore();
    }
  });

  it('un chat que no es el del dueño nunca usa el puerto', async () => {
    const { chromium } = await import('playwright');
    const conectar = vi.spyOn(chromium, 'connectOverCDP');
    const lanzar = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockRejectedValue(new Error('fixture'));
    const root = mkdtempSync(join(tmpdir(), 'pa-cdp-'));
    tmp.push(root);
    const servicio = new BrowserService({
      profilesDir: root,
      policy: {
        autoApprove: true,
        allowPrivateHosts: true,
        adSkipIntervalMs: 0,
        approve: async () => true,
      },
      sharedProfileKey: (scope) => ownerBrowserProfileKey(scope, 42),
      cdpPort: 9222,
      cdpDeps: { fetchVersion: async () => true },
    });
    try {
      await servicio.open('telegram:-100123#main', 'http://example.com/').catch(() => undefined);
      expect(conectar).not.toHaveBeenCalled();
      expect(lanzar).toHaveBeenCalled();
    } finally {
      conectar.mockRestore();
      lanzar.mockRestore();
    }
  });
});
