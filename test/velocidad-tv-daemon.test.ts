// Velocidad de la tele (asis-velocidad-1): cableado del daemon.
// keepAlive = sesión persistente, sin sonda de auto-selección si la tele acaba
// de contestar y sin volver a esperar a Glasshouse si no contestó hace poco.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vault = new Map<string, string>();
vi.mock('../src/vault.js', () => ({
  vaultGet: async (k: string) => vault.get(k),
  vaultSet: async (k: string, v: string) => {
    vault.set(k, v);
  },
  vaultSetMany: async (e: Record<string, string>) => {
    for (const [k, v] of Object.entries(e)) vault.set(k, v);
  },
}));

const ensureActiveTv = vi.fn(async () => ({ host: '192.168.1.50', brand: 'lg' }));
vi.mock('../src/tv/auto-select.js', () => ({ ensureActiveTv }));

const ghControl = vi.fn();
vi.mock('../src/tv/glasshouse.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/glasshouse.js')>();
  class GlasshouseClient {
    async control(action: string, value?: unknown) {
      return ghControl(action, value);
    }
    async getJson() {
      return {};
    }
  }
  return { ...real, GlasshouseClient };
});

const calls: Array<{ uri: string; pooled: boolean }> = [];
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    tvRequest: vi.fn(
      async (_h: string, _k: string, uri: string, _p: unknown, deps: { pool?: unknown }) => {
        calls.push({ uri, pooled: !!deps.pool });
        return { returnValue: true };
      },
    ),
    tvToast: vi.fn(async (_h: string, _k: string, _m: string, deps: { pool?: unknown }) => {
      calls.push({ uri: 'system.notifications/createToast', pooled: !!deps.pool });
    }),
    tvKey: vi.fn(async (_h: string, _k: string, name: string, deps: { pool?: unknown }) => {
      calls.push({ uri: `key:${name}`, pooled: !!deps.pool });
    }),
  };
});

const { Store } = await import('../src/db.js');
const { tvToolDeps } = await import('../src/plugins/tv.js');
const { GlasshouseUnavailableError } = await import('../src/tv/glasshouse.js');
const { TvSessionPool } = await import('../src/tv/lgtv.js');

describe('tele en el daemon (keepAlive)', () => {
  beforeEach(() => {
    vault.clear();
    vault.set('tv:host', '192.168.1.50');
    vault.set('tv:clientKey', 'KEY');
    calls.length = 0;
    ensureActiveTv.mockClear();
    ghControl.mockReset();
    vi.restoreAllMocks();
  });

  it('sin keepAlive (pa tv): ni pool ni caché, como siempre', async () => {
    ghControl.mockRejectedValue(new GlasshouseUnavailableError('no contesta'));
    const deps = tvToolDeps(new Store());
    await deps.launch('netflix');
    await deps.launch('netflix');
    expect(ghControl).toHaveBeenCalledTimes(2);
    expect(calls.every((c) => !c.pooled)).toBe(true);
    expect(ensureActiveTv).toHaveBeenCalledTimes(2);
  });

  it('keepAlive: teclas y peticiones van por la sesión persistente', async () => {
    const deps = tvToolDeps(new Store(), { keepAlive: true });
    await deps.key('DOWN');
    await deps.foreground();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.pooled)).toBe(true);
  });

  it('keepAlive: Glasshouse caído no se vuelve a esperar en cada launch', async () => {
    vault.set('tv:glasshouseUrl', 'http://192.168.1.77:8080');
    ghControl.mockRejectedValue(new GlasshouseUnavailableError('no contesta'));
    const deps = tvToolDeps(new Store(), { keepAlive: true });
    await deps.launch('netflix');
    await deps.launch('youtube.leanback.v4');
    await deps.toast('hola');
    expect(ghControl).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.uri)).toEqual([
      'system.launcher/launch',
      'system.launcher/launch',
      'system.notifications/createToast',
    ]);
  });

  it('keepAlive: Glasshouse que contesta se sigue usando', async () => {
    vault.set('tv:glasshouseUrl', 'http://192.168.1.78:8080');
    ghControl.mockResolvedValue({ ok: true });
    const deps = tvToolDeps(new Store(), { keepAlive: true });
    await deps.launch('netflix');
    await deps.launch('netflix');
    expect(ghControl).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(0);
  });

  it('keepAlive: sin sonda de auto-selección si la tele contestó hace nada', async () => {
    vi.spyOn(TvSessionPool.prototype, 'answeredWithin').mockReturnValue(true);
    const deps = tvToolDeps(new Store(), { keepAlive: true });
    await deps.key('UP');
    await deps.key('UP');
    expect(ensureActiveTv).not.toHaveBeenCalled();
  });

  it('keepAlive: si no ha contestado hace poco, la sonda se hace como siempre', async () => {
    vi.spyOn(TvSessionPool.prototype, 'answeredWithin').mockReturnValue(false);
    const deps = tvToolDeps(new Store(), { keepAlive: true });
    await deps.key('UP');
    expect(ensureActiveTv).toHaveBeenCalledTimes(1);
  });
});
