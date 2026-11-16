import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import {
  checkProviderKey,
  createProviderHandle,
  fallbackChainIds,
  fastModelIds,
  utilityModelIds,
} from '../src/core/provider.js';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  resetConfigForTests();
});
function config(preset = 'opencode') {
  process.env.OPENCODE_GO_API_KEY = 'synthetic-not-real';
  process.env.PA_PROVIDER_PRESET = preset;
  delete process.env.PA_MODEL;
  delete process.env.PA_BASE_URL;
  delete process.env.PA_PROVIDER;
  resetConfigForTests();
  return loadConfig();
}
describe('provider handle registration without network', () => {
  it('registers local primary/fallback and extra selectable models', async () => {
    const c = { ...config('opencode-local'), extraModels: ['manual-model'] };
    const h = await createProviderHandle(c);
    expect(h.modelFor().id).toBe(c.model);
    expect(h.fallbackFor?.().id).toBe(c.fallbackModel);
    expect(h.modelById?.('manual-model')?.id).toBe('manual-model');
    expect(h.modelById?.('missing')).toBeUndefined();
    await checkProviderKey(c);
  });
  it('local no-fallback remains absent', async () => {
    const c = { ...config('opencode-local'), fallbackModel: undefined };
    const h = await createProviderHandle(c);
    expect(h.fallbackFor).toBeUndefined();
  });
  it('registers explicit Go helpers, fallback chain and optional key pool', async () => {
    process.env.PA_EXTRA_API_KEYS = 'second-synthetic,third-synthetic';
    const c = {
      ...config(),
      fallbackModel: 'back-one',
      fallbackModels: ['back-two', 'back-one'],
      extraModels: ['manual'],
      utilityModel: 'utility',
      fastModel: 'fast',
    };
    const h = await createProviderHandle(c);
    expect(h.fallbackFor?.('sid').id).toBe('back-one');
    expect(h.fallbackChainFor?.('sid').map((m) => m.id)).toEqual(['back-one', 'back-two']);
    expect(h.utilityFor?.('sid').id).toBe('utility');
    expect(h.modelById?.('manual', 'sid')?.id).toBe('manual');
    expect(h.modelById?.('fast')?.id).toBe('fast');
    expect(h.modelById?.('missing')).toBeUndefined();
    expect(h.rotateKey?.()).toBe(true);
    await checkProviderKey(c);
  });
  it('Go no explicit session or helpers stays unchanged', async () => {
    const c = config();
    const h = await createProviderHandle(c);
    expect(h.modelFor().id).toBe(c.model);
    expect(h.utilityFor).toBeUndefined();
  });
  it('dedupes empty and repeated fallback/helper IDs', () => {
    const c = {
      model: 'm',
      fallbackModel: 'b',
      fallbackModels: ['', 'm', 'b', 'c', 'c'],
      utilityModel: 'm',
      fastModel: 'b',
    };
    expect(fallbackChainIds(c)).toEqual(['b', 'c']);
    expect(utilityModelIds(c)).toEqual([]);
    expect(fastModelIds(c)).toEqual([]);
    expect(utilityModelIds({ model: 'm', utilityModel: 'u' })).toEqual(['u']);
  });
});

it('custom stream wiring passes fetch override and returns a completion without network', async () => {
  const c = { ...config(), baseUrl: 'https://example.invalid/v1' };
  process.env.PA_API_KEY = 'synthetic';
  const h = await createProviderHandle(c);
  const fakeFetch: typeof fetch = async () =>
    new Response(
      [
        'data: {"id":"synthetic","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
        'data: {"id":"synthetic","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const stream = h.streamFn(h.modelFor('test'), { messages: [] }, { fetch: fakeFetch });
  const result = await stream.result();
  expect(result.role).toBe('assistant');
});
