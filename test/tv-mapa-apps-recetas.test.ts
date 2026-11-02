/**
 * Mapa de la tele (asis-computeruse-2): lista de apps guardada por tele y
 * recetas de búsqueda por app (YouTube, Netflix, Movistar Plus+).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vault = new Map<string, string>();
vi.mock('../src/vault.js', () => ({
  vaultGet: async (k: string) => vault.get(k),
  vaultSet: async (k: string, v: string) => {
    vault.set(k, v);
  },
  vaultSetMany: async () => {},
}));
vi.mock('../src/tv/auto-select.js', () => ({ ensureActiveTv: async () => ({}) }));
const calls: Array<{ uri: string; payload: unknown }> = [];
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    tvRequest: vi.fn(async (_h: string, _k: string, uri: string, payload: unknown) => {
      calls.push({ uri, payload });
      if (uri.endsWith('listLaunchPoints')) {
        return { launchPoints: [{ id: 'com.telefonica.app.nux', title: 'Movistar Plus+' }] };
      }
      return { returnValue: true };
    }),
  };
});

const { Store } = await import('../src/db.js');
const { tvToolDeps } = await import('../src/plugins/tv.js');
const { createTvTool } = await import('../src/tools/tv.js');
type TvToolDeps = import('../src/tools/tv.js').TvToolDeps;
const { createTvAppCache } = await import('../src/tv/app-cache.js');
const { appSearchRecipe, deepLaunchPayload } = await import('../src/tv/search-recipes.js');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);

function fakeDeps(over: Partial<TvToolDeps> = {}): TvToolDeps {
  return {
    shot: async () => ({ image: JPEG, mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'youtube.leanback.v4', category: [] }),
    apps: async () => [],
    launch: async () => {},
    key: async () => {},
    toast: async () => {},
    power: async () => {},
    saveFrame: () => '/tmp/tv-1.jpg',
    getState: () => null,
    setState: () => {},
    ...over,
  };
}

function kv() {
  const m = new Map<string, string>();
  return {
    m,
    kvGet: (k: string) => m.get(k) ?? null,
    kvSet: (k: string, v: string) => m.set(k, v),
  };
}

describe('recetas de búsqueda por app', () => {
  it('YouTube busca por params.contentTarget, sin teclado', () => {
    expect(appSearchRecipe('youtube.leanback.v4', 'Bailando Enrique Iglesias')).toEqual({
      kind: 'params',
      appId: 'youtube.leanback.v4',
      app: 'YouTube',
      params: {
        contentTarget: 'https://www.youtube.com/tv#/search?q=Bailando%20Enrique%20Iglesias',
      },
    });
    expect(appSearchRecipe('org.webosbrew.youtube.adfree', 'x')?.kind).toBe('params');
  });

  it('Netflix por contentId m=… y Movistar Plus+ por teclado (sin enlace inventado)', () => {
    const n = appSearchRecipe('netflix', 'La casa de papel');
    expect(n).toMatchObject({ kind: 'contentId', appId: 'netflix' });
    expect(n?.kind === 'contentId' && n.contentId).toBe(
      'm=https://www.netflix.com/search?q=La%20casa%20de%20papel&source_type=4',
    );
    expect(appSearchRecipe('com.telefonica.app.nux', 'Ceuta Sporting')?.kind).toBe('keyboard');
    expect(appSearchRecipe('com.disney.disneyplus-prod', 'x')).toBeNull();
    expect(appSearchRecipe('netflix', '   ')).toBeNull();
  });

  it('el deeplink de YouTube lleva params.contentTarget (la app no lee contentId)', () => {
    expect(deepLaunchPayload('youtube.leanback.v4', 'v=dQw4w9WgXcQ')).toEqual({
      id: 'youtube.leanback.v4',
      contentId: 'v=dQw4w9WgXcQ',
      params: { contentTarget: 'v=dQw4w9WgXcQ' },
    });
    expect(
      deepLaunchPayload('youtube.leanback.v4', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')
        .params,
    ).toEqual({ contentTarget: 'v=dQw4w9WgXcQ' });
    expect(deepLaunchPayload('netflix', 'm=https://www.netflix.com/watch/1')).toEqual({
      id: 'netflix',
      contentId: 'm=https://www.netflix.com/watch/1',
    });
  });
});

describe('tool tv: action=search con appId', () => {
  it('«busca Bailando en YouTube»: UNA orden a la tele y captura, sin búsqueda universal', async () => {
    const launchParams = vi.fn(async () => {});
    const search = vi.fn(async () => ({}));
    const tool = createTvTool(fakeDeps({ launchParams, search }));
    const res = await tool.execute('t', {
      action: 'search',
      text: 'Bailando Enrique Iglesias',
      appId: 'YouTube',
    });
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', {
      contentTarget: 'https://www.youtube.com/tv#/search?q=Bailando%20Enrique%20Iglesias',
    });
    expect(search).not.toHaveBeenCalled();
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
    expect(res.details).toMatchObject({ recipe: 'params', verified: false });
  });

  it('Movistar Plus+: búsqueda universal y la receta de teclado como pista', async () => {
    const launchParams = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ launchParams, search: async () => ({ results: [] }) }));
    const res = await tool.execute('t', {
      action: 'search',
      text: 'Ceuta',
      appId: 'Movistar Plus+',
    });
    expect(launchParams).not.toHaveBeenCalled();
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('action=guide');
  });

  it('sin launchDeep, Netflix cae a la búsqueda universal de siempre', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const tool = createTvTool(fakeDeps({ search }));
    await tool.execute('t', { action: 'search', text: 'Dark', appId: 'netflix' });
    expect(search).toHaveBeenCalledWith('Dark');
  });

  it('sin appId no cambia nada: búsqueda universal', async () => {
    const launchParams = vi.fn(async () => {});
    const search = vi.fn(async () => ({ results: [] }));
    const tool = createTvTool(fakeDeps({ launchParams, search }));
    await tool.execute('t', { action: 'search', text: 'Dark' });
    expect(search).toHaveBeenCalledTimes(1);
    expect(launchParams).not.toHaveBeenCalled();
  });
});

describe('lista de apps guardada', () => {
  it('se pide una vez, se guarda en kv y otra instancia la reutiliza sin preguntar a la tele', async () => {
    const store = kv();
    let t = 1_000;
    const fetch = vi.fn(async () => [{ id: 'rtve', title: 'RTVE Play' }]);
    const a = createTvAppCache({ store, now: () => t });
    await a.get('h1', fetch);
    await a.get('h1', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const b = createTvAppCache({ store, now: () => t });
    expect(await b.get('h1', fetch)).toEqual([{ id: 'rtve', title: 'RTVE Play' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // otra tele, su propia lista
    await b.get('h2', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    // caduca
    t += 13 * 60 * 60_000;
    await b.get('h1', fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('fresh e invalidate la vuelven a pedir; dos peticiones a la vez son una', async () => {
    const store = kv();
    const fetch = vi.fn(async () => [{ id: 'a', title: 'A' }]);
    const c = createTvAppCache({ store });
    await Promise.all([c.get('h', fetch), c.get('h', fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await c.get('h', fetch, { fresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    c.invalidate('h');
    await createTvAppCache({ store }).get('h', fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('un kv corrupto no rompe nada: se pide a la tele', async () => {
    const store = kv();
    store.m.set('tv:apps:h', '{"at":"x"');
    const fetch = vi.fn(async () => []);
    await createTvAppCache({ store }).get('h', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('launch con un nombre que no está en la lista guardada la pide fresca; un fallo la tira', async () => {
    const apps = vi.fn(async (o?: { fresh?: boolean }) =>
      o?.fresh ? [{ id: 'rtve.play', title: 'RTVE Play' }] : [{ id: 'x', title: 'Otra' }],
    );
    const launch = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ apps, launch }));
    await tool.execute('t', { action: 'launch', appId: 'RTVE Play' });
    expect(launch).toHaveBeenCalledWith('rtve.play');
    const forgetApps = vi.fn(async () => {});
    const failing = createTvTool(
      fakeDeps({
        apps,
        forgetApps,
        launch: async () => {
          throw new Error('no existe');
        },
      }),
    );
    await expect(failing.execute('t', { action: 'launch', appId: 'RTVE Play' })).rejects.toThrow();
    expect(forgetApps).toHaveBeenCalledTimes(1);
  });
});

describe('plugin LG: apps guardadas y arranque con parámetros', () => {
  beforeEach(() => {
    calls.length = 0;
    vault.clear();
    vault.set('tv:host', '192.168.1.50');
    vault.set('tv:clientKey', 'K');
  });

  it('dos «abre Movistar» seguidos piden la lista UNA vez; launchDeep de YouTube lleva contentTarget', async () => {
    const deps = tvToolDeps(new Store());
    await deps.apps();
    await deps.apps();
    expect(calls.filter((c) => c.uri.endsWith('listLaunchPoints'))).toHaveLength(1);
    await deps.launchDeep?.('youtube.leanback.v4', 'v=dQw4w9WgXcQ');
    expect(calls.at(-1)).toEqual({
      uri: 'system.launcher/launch',
      payload: {
        id: 'youtube.leanback.v4',
        contentId: 'v=dQw4w9WgXcQ',
        params: { contentTarget: 'v=dQw4w9WgXcQ' },
      },
    });
    await deps.launchParams?.('youtube.leanback.v4', { contentTarget: 'x' });
    expect(calls.at(-1)?.payload).toEqual({
      id: 'youtube.leanback.v4',
      params: { contentTarget: 'x' },
    });
  });
});
