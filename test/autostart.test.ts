import { describe, expect, it, vi } from 'vitest';
import { notifyAutostart, SUPERVISOR_MESSAGES } from '../src/autostart.js';

describe('supervisor Telegram notices use only fixed, allowlisted owner DM', () => {
  function deps(values: Record<string, string | undefined>) {
    return {
      unlock: vi.fn(async () => {}),
      get: vi.fn(async (key: string) => values[key]),
      fetch: vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}'),
      ),
    };
  }
  it('sends fixed content to single allowlisted owner, never a group or config dump', async () => {
    const d = deps({ 'telegram:allowedUserIds': '123', 'telegram:botToken': 'synthetic' });
    expect(await notifyAutostart('forced', d)).toBe(0);
    expect(JSON.parse(String(d.fetch.mock.calls[0]?.[1]?.body))).toEqual({
      chat_id: 123,
      text: SUPERVISOR_MESSAGES.forced,
    });
  });
  it.each([
    { 'telegram:allowedUserIds': '1,2' },
    { 'telegram:allowedUserIds': '1,2', 'vigilante:ownerUserId': '99' },
    { 'telegram:allowedUserIds': '-123' },
    { 'telegram:allowedUserIds': '' },
  ])('refuses ambiguous/unallowlisted/group owner %j', async (v) => {
    const d = deps({ ...v, 'telegram:botToken': 'synthetic' });
    expect(await notifyAutostart('blocked', d)).toBe(1);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('uses explicitly allowlisted owner among multiple users', async () => {
    const d = deps({
      'telegram:allowedUserIds': '1,2',
      'vigilante:ownerUserId': '2',
      'telegram:botToken': 'synthetic',
    });
    expect(await notifyAutostart('restart', d)).toBe(0);
    expect(JSON.parse(String(d.fetch.mock.calls[0]?.[1]?.body)).chat_id).toBe(2);
  });
  it.each(['__proto__', 'constructor', 'secret text'])(
    'refuses arbitrary notice %s',
    async (event) => {
      const d = deps({});
      expect(await notifyAutostart(event, d)).toBe(2);
      expect(d.unlock).not.toHaveBeenCalled();
    },
  );
  it('does not claim delivery on API rejection', async () => {
    const d = deps({ 'telegram:allowedUserIds': '1', 'telegram:botToken': 'synthetic' });
    d.fetch.mockResolvedValue(new Response('{"ok":false}', { status: 403 }));
    expect(await notifyAutostart('restart', d)).toBe(1);
  });
});

describe('OpenCode health contract, no inference', () => {
  it('does not call a model and rejects mere TCP/JSON success', async () => {
    const { localLlmHealthy } = await import('../src/autostart.js');
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}'),
    );
    expect(await localLlmHealthy(fetcher)).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4096/global/health');
    fetcher.mockResolvedValue(new Response('{"healthy":true,"version":"synthetic"}'));
    expect(await localLlmHealthy(fetcher)).toBe(true);
  });
});
