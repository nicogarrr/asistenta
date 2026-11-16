import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { createProviderHandle } from '../src/core/provider.js';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
  resetConfigForTests();
});
it('guards direct SDK summaries and streams, overriding caller fetch', async () => {
  process.env.PA_PROVIDER_PRESET = 'opencode';
  process.env.PA_MODEL = 'hy4-flash-free';
  process.env.OPENCODE_GO_API_KEY = 'synthetic';
  delete process.env.PA_BASE_URL;
  resetConfigForTests();
  const calls: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/models'))
      return Response.json({
        data: [
          {
            id: 'hy4-flash-free',
            cost: { text: { input: { price: 0 }, output: { price: 0 } } },
            api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } },
          },
        ],
      });
    const chunk = {
      id: 'synthetic',
      object: 'chat.completion.chunk',
      model: 'hy4-flash-free',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        cost: 0,
        opencode: { billing_source: 'go', list_cost: 0, allowance: 0 },
      },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  vi.stubGlobal('fetch', fake);
  const h = await createProviderHandle(loadConfig());
  const bypass = vi.fn<typeof fetch>();
  await h.models.completeSimple(
    h.model,
    { messages: [] },
    { fetch: bypass, sessionId: 'synthetic' },
  );
  await h.models
    .streamSimple(h.model, { messages: [] }, { fetch: bypass, sessionId: 'synthetic' })
    .result();
  expect(bypass).not.toHaveBeenCalled();
  expect(calls).toHaveLength(4);
  expect(calls.filter((c) => c.endsWith('/models'))).toHaveLength(2);
});
