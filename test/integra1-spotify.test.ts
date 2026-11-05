import { beforeEach, describe, expect, it } from 'vitest';
import { Gate, SPOTIFY_FREE_ACTIONS } from '../src/permissions.js';
import {
  pickDevice,
  resetSpotifyCacheForTests,
  SPOTIFY_KEYS,
  spotifyDo,
  startSpotifyLogin,
} from '../src/spotify.js';
import { spotifyCommand } from '../src/tools/spotify.js';

const ENV = { PA_SPOTIFY_CLIENT_ID: 'abcdef0123456789abcdef0123456789' };

function vault(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => m.delete(k),
  };
}

type Call = { method: string; url: string; body?: string };
function fakeFetch(routes: (c: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { method: init?.method ?? 'GET', url: String(url), body: init?.body as string };
    calls.push(c);
    const r = routes(c);
    return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), {
      status: r.status,
    });
  }) as typeof fetch;
  return { f, calls };
}

const token = (c: Call) =>
  c.url.endsWith('/api/token')
    ? { status: 200, json: { access_token: 'AT', expires_in: 3600 } }
    : null;

beforeEach(() => resetSpotifyCacheForTests());

describe('Spotify por API', () => {
  it('sin PA_SPOTIFY_CLIENT_ID lo dice en castellano y no llama a nada', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 500 }));
    const t = await spotifyDo({ env: {}, vault: vault(), fetch: f }, { action: 'pausa' });
    expect(t).toContain('PA_SPOTIFY_CLIENT_ID');
    expect(calls).toEqual([]);
    expect(
      (
        await spotifyCommand('', {
          env: {},
          vault: vault(),
          openBrowser: async () => true,
          notify: () => {},
        })
      ).text,
    ).toContain('SETUP-INTEGRACIONES');
  });

  it('sin conectar pide /spotify conectar', async () => {
    const t = await spotifyDo({ env: ENV, vault: vault() }, { action: 'estado' });
    expect(t).toContain('/spotify conectar');
  });

  it('«pon» busca la canción y la pone; dice cuál', async () => {
    const { f, calls } = fakeFetch(
      (c) =>
        token(c) ??
        (c.url.includes('/search')
          ? {
              status: 200,
              json: {
                tracks: {
                  items: [
                    {
                      uri: 'spotify:track:1',
                      name: 'Tití Me Preguntó',
                      artists: [{ name: 'Bad Bunny' }],
                    },
                  ],
                },
              },
            }
          : { status: 204 }),
    );
    const v = vault({ [SPOTIFY_KEYS.refreshToken]: 'RT' });
    const t = await spotifyDo(
      { env: ENV, vault: v, fetch: f },
      { action: 'pon', query: 'titi me pregunto' },
    );
    expect(t).toBe('▶️ Pongo «Tití Me Preguntó» de Bad Bunny.');
    const play = calls.find((c) => c.url.endsWith('/me/player/play'));
    expect(play?.method).toBe('PUT');
    expect(JSON.parse(play?.body ?? '{}')).toEqual({ uris: ['spotify:track:1'] });
    expect(calls[0]?.body).toContain('client_id=abcdef0123456789abcdef0123456789');
  });

  it('una playlist va como contexto', async () => {
    const { f, calls } = fakeFetch(
      (c) =>
        token(c) ??
        (c.url.includes('/search')
          ? {
              status: 200,
              json: { playlists: { items: [null, { uri: 'spotify:playlist:9', name: 'Lo-fi' }] } },
            }
          : { status: 204 }),
    );
    const t = await spotifyDo(
      { env: ENV, vault: vault({ [SPOTIFY_KEYS.refreshToken]: 'RT' }), fetch: f },
      { action: 'pon', query: 'lofi', tipo: 'playlist' },
    );
    expect(t).toContain('Lo-fi');
    expect(calls.find((c) => c.url.includes('type=playlist'))).toBeTruthy();
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({ context_uri: 'spotify:playlist:9' });
  });

  it('sin Premium (403) y sin dispositivo (404) lo explica', async () => {
    const v = () => vault({ [SPOTIFY_KEYS.refreshToken]: 'RT' });
    const p = fakeFetch((c) => token(c) ?? { status: 403 });
    expect(await spotifyDo({ env: ENV, vault: v(), fetch: p.f }, { action: 'pausa' })).toContain(
      'Premium',
    );
    resetSpotifyCacheForTests();
    const n = fakeFetch((c) => token(c) ?? { status: 404 });
    expect(
      await spotifyDo({ env: ENV, vault: v(), fetch: n.f }, { action: 'siguiente' }),
    ).toContain('Abre Spotify');
  });

  it('qué suena y en qué dispositivo; pasar la música al PC', async () => {
    const { f, calls } = fakeFetch(
      (c) =>
        token(c) ??
        (c.url.endsWith('/me/player') && c.method === 'GET'
          ? {
              status: 200,
              json: {
                is_playing: true,
                item: { name: 'Clocks', artists: [{ name: 'Coldplay' }] },
                device: { name: 'iPhone' },
              },
            }
          : c.url.endsWith('/devices')
            ? {
                status: 200,
                json: {
                  devices: [{ id: 'd1', name: 'NICO-PC', type: 'Computer', is_active: false }],
                },
              }
            : { status: 204 }),
    );
    const d = { env: ENV, vault: vault({ [SPOTIFY_KEYS.refreshToken]: 'RT' }), fetch: f };
    expect(await spotifyDo(d, { action: 'estado' })).toBe(
      '▶️ Suena: «Clocks» de Coldplay en iPhone.',
    );
    expect(await spotifyDo(d, { action: 'usar_dispositivo', dispositivo: 'el PC' })).toBe(
      '🔈 Ahora suena en NICO-PC.',
    );
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({ device_ids: ['d1'], play: true });
  });

  it('pickDevice entiende móvil, tele y nombres', () => {
    const l = [
      { id: '1', name: 'Pixel 8', type: 'Smartphone', active: false, volume: null },
      { id: '2', name: 'Salón', type: 'TV', active: false, volume: null },
    ];
    expect(pickDevice(l, 'móvil')?.id).toBe('1');
    expect(pickDevice(l, 'la tele')?.id).toBe('2');
    expect(pickDevice(l, 'salon')?.id).toBe('2');
    expect(pickDevice(l, 'cocina')).toBeUndefined();
  });

  it('conectar: PKCE con S256 y vuelta a 127.0.0.1; guarda el refresh token', async () => {
    const v = vault();
    const { f } = fakeFetch(() => ({
      status: 200,
      json: { access_token: 'AT', refresh_token: 'RT2' },
    }));
    const env = {
      ...ENV,
      PA_SPOTIFY_REDIRECT_PORT: String(40000 + Math.floor(Math.random() * 20000)),
    };
    const flow = await startSpotifyLogin({ env, vault: v, fetch: f });
    const u = new URL(flow.url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${env.PA_SPOTIFY_REDIRECT_PORT}/callback`,
    );
    const back = await fetch(
      `http://127.0.0.1:${env.PA_SPOTIFY_REDIRECT_PORT}/callback?code=C&state=${u.searchParams.get('state')}`,
    );
    expect(await back.text()).toContain('Spotify conectado');
    await flow.done;
    expect(v.m.get(SPOTIFY_KEYS.refreshToken)).toBe('RT2');
  });

  it('la Gate deja «pon»/pausa sin preguntar y trata estado como lectura', () => {
    const gate = new Gate({ approver: () => true });
    expect(
      gate.classifyEffect({ tool: 'spotify', args: { action: 'estado' }, actor: 'test' }),
    ).toBe('lee');
    expect(
      gate.classifyEffect({ tool: 'spotify', args: { action: 'pon' }, actor: 'test' }),
    ).toBeNull();
    expect(SPOTIFY_FREE_ACTIONS).toContain('spotify:pon');
    expect(SPOTIFY_FREE_ACTIONS).toContain('spotify:pausa');
  });
});
