import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  GOOGLE_KEYS,
  GoogleAuth,
  GoogleNotConnectedError,
  googleFetch,
  parseClientJson,
  pkcePair,
  startLoopbackFlow,
} from '../src/google/oauth.js';

function fakeVault(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => m.delete(k),
  };
}
const client = { [GOOGLE_KEYS.clientId]: 'cid', [GOOGLE_KEYS.clientSecret]: 'csec' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('google oauth', () => {
  it('builds a PKCE S256 offline consent link', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const u = new URL(
      buildAuthUrl({
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:5',
        scopes: ['a', 'b'],
        state: 's',
        challenge,
      }),
    );
    expect(u.host).toBe('accounts.google.com');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toBe('a b');
  });

  it('reads the downloaded client JSON', () => {
    expect(parseClientJson('{"installed":{"client_id":"x","client_secret":"y"}}')).toEqual({
      clientId: 'x',
      clientSecret: 'y',
    });
    expect(() => parseClientJson('{}')).toThrow(/JSON del cliente/);
  });

  it('only talks to Google hosts', () => {
    const f = vi.fn();
    expect(() => googleFetch({ fetch: f }, 'https://evil.example/token')).toThrow(/no permitido/);
    expect(() => googleFetch({ fetch: f }, 'http://oauth2.googleapis.com/token')).toThrow();
    expect(f).not.toHaveBeenCalled();
  });

  it('loopback flow checks state, sends the verifier and stores the refresh token', async () => {
    const vault = fakeVault(client);
    let sent: URLSearchParams | undefined;
    const gfetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return json(200, {
        access_token: 'at',
        refresh_token: 'rt',
        scope: 'https://www.googleapis.com/auth/calendar.events',
      });
    }) as unknown as typeof fetch;
    const flow = await startLoopbackFlow({ vault, fetch: gfetch });
    const auth = new URL(flow.url);
    const redirect = auth.searchParams.get('redirect_uri') ?? '';
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const bad = await fetch(`${redirect}/?code=c&state=wrong`);
    expect(bad.status).toBe(400);
    expect(vault.m.has(GOOGLE_KEYS.refreshToken)).toBe(false);
    const ok = await fetch(`${redirect}/?code=c1&state=${auth.searchParams.get('state')}`);
    expect(await ok.text()).toContain('Google conectado');
    await expect(flow.done).resolves.toEqual({
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });
    expect(vault.m.get(GOOGLE_KEYS.refreshToken)).toBe('rt');
    const verifier = sent?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    );
    expect(sent?.get('code')).toBe('c1');
  });

  it('without a client it says what to do', async () => {
    await expect(startLoopbackFlow({ vault: fakeVault() })).rejects.toThrow(/docs\/google\.md/);
  });

  it('refreshes with backoff on 5xx and caches the token', async () => {
    const vault = fakeVault({ ...client, [GOOGLE_KEYS.refreshToken]: 'rt' });
    const sleep = vi.fn(async () => {});
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(503, {}))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200, { access_token: 'at1', expires_in: 3600 }));
    const auth = new GoogleAuth({
      vault,
      fetch: f as unknown as typeof fetch,
      sleep,
      now: () => 0,
    });
    expect(await auth.accessToken()).toBe('at1');
    expect(await auth.accessToken()).toBe('at1');
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it('a revoked grant clears the token and asks to reconnect', async () => {
    const vault = fakeVault({ ...client, [GOOGLE_KEYS.refreshToken]: 'rt' });
    const f = vi.fn().mockResolvedValue(json(400, { error: 'invalid_grant' }));
    const auth = new GoogleAuth({
      vault,
      fetch: f as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(auth.accessToken()).rejects.toBeInstanceOf(GoogleNotConnectedError);
    expect(vault.m.has(GOOGLE_KEYS.refreshToken)).toBe(false);
    await expect(auth.accessToken()).rejects.toThrow(/conecta mi Google/);
  });
});
