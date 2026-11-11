import { afterEach, describe, expect, it, vi } from 'vitest';
import { alCaerConexion, avisarConexionCaida, textoConexionCaida } from '../src/conexion-caida.js';
import { GOOGLE_KEYS, GoogleAuth, GoogleNotConnectedError } from '../src/google/oauth.js';
import { devices, resetSpotifyCacheForTests, SPOTIFY_KEYS } from '../src/spotify.js';

function fakeVault(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => m.delete(k),
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  alCaerConexion(null);
  resetSpotifyCacheForTests();
});

describe('aviso de conexión caída (Grok Bot: avisa cuando hay que reconectar)', () => {
  it('Google retira el permiso → un aviso al chat con qué deja de ir y /google conectar', async () => {
    const got: string[] = [];
    alCaerConexion((s, t) => got.push(`${s}: ${t}`));
    const vault = fakeVault({
      [GOOGLE_KEYS.clientId]: 'cid',
      [GOOGLE_KEYS.clientSecret]: 'csec',
      [GOOGLE_KEYS.refreshToken]: 'rt',
    });
    const f = vi.fn().mockResolvedValue(json(400, { error: 'invalid_grant' }));
    const auth = new GoogleAuth({
      vault,
      fetch: f as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(auth.accessToken()).rejects.toThrow(/\/google conectar/);
    await expect(auth.accessToken()).rejects.toBeInstanceOf(GoogleNotConnectedError);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^google: 🔌 Google se ha desconectado/);
    expect(got[0]).toContain('/google conectar');
    expect(got[0]).toContain('Publicar app');
  });

  it('Spotify retira el permiso → aviso con /spotify conectar', async () => {
    const got: string[] = [];
    alCaerConexion((s) => got.push(s));
    const vault = fakeVault({ [SPOTIFY_KEYS.refreshToken]: 'rt' });
    const f = vi.fn().mockResolvedValue(json(400, { error: 'invalid_grant' }));
    await expect(
      devices({
        env: { PA_SPOTIFY_CLIENT_ID: 'abcdef0123456789abcdef0123456789' },
        vault,
        fetch: f as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/retirado el permiso/);
    expect(got).toEqual(['spotify']);
    expect(textoConexionCaida('spotify')).toContain('/spotify conectar');
  });

  it('como mucho un aviso cada 12 h por servicio; sin destinatario no hace nada', () => {
    expect(avisarConexionCaida('google', 0)).toBe(false);
    const got: string[] = [];
    alCaerConexion((s) => got.push(s));
    expect(avisarConexionCaida('google', 1000)).toBe(true);
    expect(avisarConexionCaida('google', 2000)).toBe(false);
    expect(avisarConexionCaida('spotify', 2000)).toBe(true);
    expect(avisarConexionCaida('google', 1000 + 12 * 3600_000)).toBe(true);
    expect(got).toEqual(['google', 'spotify', 'google']);
  });

  it('un destinatario que falla no rompe la llamada', () => {
    alCaerConexion(() => {
      throw new Error('telegram caído');
    });
    expect(avisarConexionCaida('google', 5)).toBe(true);
  });
});
