import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

const completeSimple = vi.fn();
const createProviderHandle = vi.fn(async (_cfg: Record<string, unknown>) => ({
  models: { completeSimple },
  modelFor: (role: string) => `model-for-${role}`,
}));
vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: (cfg: Record<string, unknown>) => createProviderHandle(cfg),
}));

const { attentionFreeConfig, createAttentionJudge } = await import(
  '../src/core/attention-model.js'
);

const local = (over: Partial<Config> = {}): Config =>
  ({
    provider: 'opencode-local',
    baseUrl: 'http://127.0.0.1:4096/v1',
    model: 'big-pickle-free',
    ...over,
  }) as unknown as Config;
const router = (over: Partial<Config> = {}): Config =>
  ({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta/llama:free',
    ...over,
  }) as unknown as Config;

describe('attentionFreeConfig: only the existing free route passes (fail closed)', () => {
  it.each([
    ['local 127.0.0.1', local()],
    ['local localhost', local({ baseUrl: 'http://localhost:4096' })],
    [
      'local LOCALHOST (hostnames are case-insensitive)',
      local({ baseUrl: 'http://LOCALHOST:4096' }),
    ],
    ['local IPv6 loopback', local({ baseUrl: 'http://[::1]:4096' })],
    ['local with a free fallback', local({ fallbackModel: 'other-free' })],
    ['openrouter free', router()],
    ['openrouter with a free fallback', router({ fallbackModel: 'x/y:free' })],
  ])('%s → true', (_name, cfg) => {
    expect(attentionFreeConfig(cfg)).toBe(true);
  });

  it.each([
    ['local paid model', local({ model: 'gpt-big' })],
    ['local paid fallback', local({ fallbackModel: 'gpt-big' })],
    ['local over https', local({ baseUrl: 'https://127.0.0.1:4096' })],
    ['local on a LAN host', local({ baseUrl: 'http://192.168.1.10:4096' })],
    ['local on a lookalike host', local({ baseUrl: 'http://localhost.evil.example:4096' })],
    ['local with credentials in the URL', local({ baseUrl: 'http://user:pw@127.0.0.1:4096' })],
    ['local with an unparseable URL', local({ baseUrl: 'not a url' })],
    ['local with an empty URL', local({ baseUrl: '' })],
    ['openrouter paid model', router({ model: 'anthropic/claude' })],
    ['openrouter paid fallback', router({ fallbackModel: 'anthropic/claude' })],
    ['openrouter through another base URL', router({ baseUrl: 'https://proxy.example/api/v1' })],
    ['openrouter model that only contains :free', router({ model: 'x:free-trial' })],
    [
      'another provider with a free-looking model',
      router({ provider: 'openai' } as Partial<Config>),
    ],
  ])('%s → false', (_name, cfg) => {
    expect(attentionFreeConfig(cfg)).toBe(false);
  });
});

describe('createAttentionJudge', () => {
  beforeEach(() => {
    completeSimple.mockReset();
    createProviderHandle.mockClear();
  });

  const event = { source: 'mail', id: 'm1', text: 'Tu pedido talla S', at: 0 } as never;

  it('refuses before touching any provider when the route is not free', async () => {
    const judge = createAttentionJudge(router({ model: 'anthropic/claude' }));
    await expect(judge('screen', event, new AbortController().signal)).rejects.toThrow(
      /ruta gratuita/,
    );
    expect(createProviderHandle).not.toHaveBeenCalled();
  });

  it('screen uses the free fallback at low effort; review uses the main model and its effort', async () => {
    completeSimple.mockResolvedValue({ content: [{ type: 'text', text: '{"relevant":false}' }] });
    const judge = createAttentionJudge(
      router({ fallbackModel: 'small/x:free', variant: 'high' } as Partial<Config>),
    );
    const signal = new AbortController().signal;

    expect(await judge('screen', event, signal)).toBe('{"relevant":false}');
    expect(createProviderHandle.mock.calls[0]?.[0]).toMatchObject({
      model: 'small/x:free',
      fallbackModel: undefined,
      variant: 'low',
    });

    await judge('review', event, signal);
    expect(createProviderHandle.mock.calls[1]?.[0]).toMatchObject({
      model: 'meta/llama:free',
      fallbackModel: undefined,
      variant: 'high',
    });
  });

  it('the event travels as untrusted data, never as instructions, with a hard token cap', async () => {
    completeSimple.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: '{"relevant":' },
        { type: 'text', text: 'true}' },
      ],
    });
    const judge = createAttentionJudge(local());
    const signal = new AbortController().signal;
    const out = await judge('review', event, signal);
    expect(out).toBe('{"relevant":true}');
    const [model, ctx, opts] = completeSimple.mock.calls[0] ?? [];
    expect(model).toBe('model-for-attention');
    expect(ctx.systemPrompt).toMatch(/NO FIABLE/);
    expect(ctx.systemPrompt).toMatch(/Segunda revision/);
    expect(ctx.messages[0].content[0].text).toBe(JSON.stringify(event));
    expect(opts).toMatchObject({ maxTokens: 250, signal, sessionId: 'attention' });
  });
});
