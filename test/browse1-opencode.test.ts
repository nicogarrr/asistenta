import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isLoopbackUrl,
  OPENCODE_DEFAULT_URL,
  opencodeEndpoint,
  opencodeTokenPath,
} from '../src/browser/opencode.js';
import { BrowserService, ownerBrowserProfileKey } from '../src/browser/service.js';
import { loadConfig, resetConfigForTests } from '../src/config.js';

const TOKEN = 'tok-secreto-123';
const WS = `ws://127.0.0.1:19988/devtools/browser/abc?opencodeBrowserToken=${TOKEN}`;
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okFetch = vi.fn(
  async () => new Response(JSON.stringify({ webSocketDebuggerUrl: WS }), { status: 200 }),
);

describe('OpenCode Browse: endpoint del relay', () => {
  it('lee el token, lo manda como Bearer al relay local y devuelve la URL de CDP', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ webSocketDebuggerUrl: WS }), { status: 200 }),
    );
    const ws = await opencodeEndpoint({
      tokenPath: '/t',
      readToken: async () => `${TOKEN}\n`,
      fetchImpl: fetchImpl as never,
    });
    expect(ws).toBe(WS);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OPENCODE_DEFAULT_URL}/json/version`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sin token explica cómo instalarlo en Windows, y ningún error enseña el token', async () => {
    await expect(
      opencodeEndpoint({
        readToken: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toThrow(/no está instalado.*install\.ps1/);
    const e401 = await opencodeEndpoint({
      readToken: async () => TOKEN,
      fetchImpl: (async () => new Response('', { status: 401 })) as never,
    }).catch((e: Error) => e);
    expect(String(e401)).toMatch(/no acepta su token/);
    expect(String(e401)).not.toContain(TOKEN);
    const caido = await opencodeEndpoint({
      readToken: async () => TOKEN,
      fetchImpl: (async () => {
        throw new Error(`ECONNREFUSED ${TOKEN}`);
      }) as never,
    }).catch((e: Error) => e);
    expect(String(caido)).toMatch(/no responde/);
    expect(String(caido)).not.toContain(TOKEN);
  });

  it('solo habla con 127.0.0.1: ni el token ni el control salen del equipo', async () => {
    expect(isLoopbackUrl('http://127.0.0.1:19988')).toBe(true);
    expect(isLoopbackUrl('http://100.76.209.20:19988')).toBe(false);
    expect(isLoopbackUrl('https://evil.example')).toBe(false);
    const readToken = vi.fn(async () => TOKEN);
    await expect(
      opencodeEndpoint({
        url: 'http://100.76.209.20:19988',
        readToken,
        fetchImpl: okFetch as never,
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
    expect(readToken).not.toHaveBeenCalled();
    await expect(
      opencodeEndpoint({
        readToken,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://10.0.0.5:19988/x' }), {
            status: 200,
          })) as never,
      }),
    ).rejects.toThrow(/dirección de control válida/);
  });

  it('el token está donde lo deja browse, también en Windows', () => {
    expect(opencodeTokenPath({}, 'C:\\Users\\nico')).toMatch(
      /C:\\Users\\nico[\\/]\.local[\\/]share[\\/]browse[\\/]relay-token$/,
    );
    expect(opencodeTokenPath({ XDG_DATA_HOME: '/d' }, '/h')).toBe(
      join('/d', 'browse', 'relay-token'),
    );
    expect(opencodeTokenPath({ PA_BROWSER_OPENCODE_TOKEN_FILE: '/x/t' }, '/h')).toBe('/x/t');
  });

  it('PA_BROWSER es «playwright» si no se pone, y acepta «opencode»', () => {
    const prev = process.env.PA_BROWSER;
    try {
      delete process.env.PA_BROWSER;
      resetConfigForTests();
      expect(loadConfig().browserBackend).toBe('playwright');
      process.env.PA_BROWSER = 'opencode';
      resetConfigForTests();
      expect(loadConfig().browserBackend).toBe('opencode');
    } finally {
      if (prev === undefined) delete process.env.PA_BROWSER;
      else process.env.PA_BROWSER = prev;
      resetConfigForTests();
    }
  });
});

function fakePage() {
  const close = vi.fn(async () => undefined);
  const page = new Proxy(
    { isClosed: () => false, close },
    {
      get: (t, k) =>
        k in t ? (t as never)[k] : k === 'then' ? undefined : () => Promise.resolve(undefined),
    },
  );
  return { page, close };
}

function fakeContext(existing: unknown[]) {
  const pages = [...existing];
  const created = fakePage();
  return {
    created,
    context: {
      pages: () => pages,
      newPage: async () => {
        pages.push(created.page);
        return created.page;
      },
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      close: vi.fn(async () => undefined),
      route: async () => undefined,
      on: () => undefined,
      addInitScript: async () => undefined,
      exposeFunction: async () => undefined,
    },
  };
}

function service(root: string, deps: Record<string, unknown>) {
  return new BrowserService({
    profilesDir: root,
    policy: {
      autoApprove: true,
      allowPrivateHosts: true,
      adSkipIntervalMs: 0,
      approve: async () => true,
    },
    sharedProfileKey: (scope) => ownerBrowserProfileKey(scope, 42),
    cdpPort: 0,
    backend: 'opencode',
    ...deps,
  });
}

describe('OpenCode Browse: el chat del dueño usa su Chrome normal', () => {
  it('se conecta al relay, abre su propia pestaña y al cerrar solo cierra esa y suelta la conexión', async () => {
    const { chromium } = await import('playwright');
    const tuya = fakePage();
    const { context, created } = fakeContext([tuya.page]);
    const browserClose = vi.fn(async () => undefined);
    const conectar = vi
      .spyOn(chromium, 'connectOverCDP')
      .mockResolvedValue({ contexts: () => [context], close: browserClose } as never);
    const lanzar = vi.spyOn(chromium, 'launchPersistentContext');
    const root = mkdtempSync(join(tmpdir(), 'pa-oc-'));
    tmp.push(root);
    const servicio = service(root, {
      opencode: { readToken: async () => TOKEN, fetchImpl: okFetch },
    });
    try {
      await servicio.open('telegram:dm:42#main', 'http://example.com/').catch(() => undefined);
      expect(conectar).toHaveBeenCalledWith(WS, expect.anything());
      expect(lanzar).not.toHaveBeenCalled();
      expect(servicio.isOpen('telegram:dm:42#main')).toBe(true);
      await servicio.close('telegram:dm:42#main');
      expect(created.close).toHaveBeenCalledTimes(1);
      expect(tuya.close).not.toHaveBeenCalled();
      expect(browserClose).toHaveBeenCalledTimes(1);
      expect(context.close).not.toHaveBeenCalled();
    } finally {
      conectar.mockRestore();
      lanzar.mockRestore();
    }
  });

  it('un chat que no es el del dueño nunca usa su Chrome', async () => {
    const { chromium } = await import('playwright');
    const conectar = vi.spyOn(chromium, 'connectOverCDP');
    const lanzar = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockRejectedValue(new Error('fixture'));
    const readToken = vi.fn(async () => TOKEN);
    const root = mkdtempSync(join(tmpdir(), 'pa-oc-'));
    tmp.push(root);
    const servicio = service(root, { opencode: { readToken, fetchImpl: okFetch } });
    try {
      await servicio.open('telegram:-100123#main', 'http://example.com/').catch(() => undefined);
      expect(readToken).not.toHaveBeenCalled();
      expect(conectar).not.toHaveBeenCalled();
      expect(lanzar).toHaveBeenCalled();
    } finally {
      conectar.mockRestore();
      lanzar.mockRestore();
    }
  });

  it('si OpenCode Browse no está, sigue con el navegador de siempre y lo dice en una línea', async () => {
    const { chromium } = await import('playwright');
    const { context } = fakeContext([]);
    const conectar = vi.spyOn(chromium, 'connectOverCDP');
    const lanzar = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockResolvedValue(context as never);
    const root = mkdtempSync(join(tmpdir(), 'pa-oc-'));
    tmp.push(root);
    const servicio = service(root, {
      opencode: {
        readToken: async () => {
          throw new Error('ENOENT');
        },
      },
    });
    try {
      const r = await servicio.open('telegram:dm:42#main', 'http://example.com/');
      expect(conectar).not.toHaveBeenCalled();
      expect(lanzar).toHaveBeenCalledTimes(1);
      expect(r.note).toMatch(
        /No pude usar tu Chrome con OpenCode Browse \(OpenCode Browse no está instalado/,
      );
      expect(r.note?.split('\n').length).toBe(1);
    } finally {
      conectar.mockRestore();
      lanzar.mockRestore();
      await servicio.closeAll().catch(() => undefined);
    }
  });
});
