/**
 * Canal pedido (Chrome instalado) que no está o no arranca: el servicio debe caer
 * al Chromium empaquetado en vez de morir. Un error de arranque distinto (perfil
 * bloqueado, opciones mal) es real y tiene que propagarse.
 *
 * Playwright va simulado: lo que se prueba es la decisión de fallback de #launch,
 * no un navegador de verdad (eso lo cubre antibot-browser con PA_TEST_REAL_BROWSER=1).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  attempts: [] as Array<string | undefined>,
  failNextWith: null as Error | null,
}));

function fake(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop in target) return target[prop as string];
      return () => Promise.resolve(undefined);
    },
  });
}

vi.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: async (_dir: string, opts?: { channel?: string }) => {
      state.attempts.push(opts?.channel);
      if (state.failNextWith) {
        const err = state.failNextWith;
        state.failNextWith = null;
        throw err;
      }
      const page = fake({
        on: () => undefined,
        url: () => 'about:blank',
        title: async () => '',
        goBack: async () => null,
      });
      return fake({
        pages: () => [page],
        setDefaultTimeout: () => undefined,
        setDefaultNavigationTimeout: () => undefined,
        on: () => undefined,
        close: async () => undefined,
      });
    },
  },
}));

const { BrowserService } = await import('../src/browser/service.js');

describe('fallback de canal de navegador', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-canal-'));
  const services: Array<{ closeAll: () => Promise<void> }> = [];

  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.closeAll()));
  });

  beforeEach(() => {
    state.attempts = [];
    state.failNextWith = null;
  });

  const make = () => {
    const s = new BrowserService({
      policy: { approve: async () => true },
      profilesDir: join(root, `profiles-${services.length}`),
      channel: 'chrome',
    });
    services.push(s);
    return s;
  };

  it('un Chrome que no arranca a tiempo cae al chromium empaquetado', async () => {
    state.failNextWith = new Error(
      'browserType.launchPersistentContext: Timeout 30000ms exceeded.',
    );
    await make().back('t#1');
    expect(state.attempts).toEqual(['chrome', undefined]);
  });

  it('un Chrome que no está instalado cae al chromium empaquetado', async () => {
    state.failNextWith = new Error(
      "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\Chrome\\chrome.exe",
    );
    await make().back('t#2');
    expect(state.attempts).toEqual(['chrome', undefined]);
  });

  it('otro error de arranque es real y se propaga', async () => {
    state.failNextWith = new Error('The profile is already in use');
    await expect(make().back('t#3')).rejects.toThrow(/profile is already in use/);
    expect(state.attempts).toEqual(['chrome']);
  });
});
