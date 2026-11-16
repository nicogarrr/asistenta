import { beforeEach, describe, expect, it, vi } from 'vitest';

function catalog() {
  return {
    data: [
      {
        id: 'hy4-flash-free',
        cost: { text: { input: { price: 0 }, output: { price: 0 } } },
        api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } },
      },
    ],
  };
}
function completion() {
  return {
    model: 'hy4-flash-free',
    usage: { cost: 0, opencode: { billing_source: 'go', list_cost: 0, allowance: 0 } },
  };
}
beforeEach(() => vi.resetModules());
async function setup(doc = completion(), cat = catalog(), sse = false) {
  const mod = await import('../src/core/hy4-zero.js');
  const inner = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(cat))
    .mockResolvedValueOnce(
      sse
        ? new Response(`data: ${JSON.stringify(doc)}\n\ndata: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        : Response.json(doc),
    );
  const fetch = mod.createHy4ZeroFetch(inner);
  const invoke = () =>
    fetch(`${mod.HY4_BASE}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: mod.HY4 }),
    });
  return { ...mod, inner, fetch, invoke };
}
describe('Hy4 strict zero Go', () => {
  it.each([false, true])(
    'checks catalog and complete billing before returning, SSE=%s',
    async (sse) => {
      const s = await setup(completion(), catalog(), sse);
      expect((await s.invoke()).ok).toBe(true);
      expect(s.inner).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['cost', 'billing_source', 'allowance', 'list_cost', 'model', 'usage'])(
    'latches on invalid %s',
    async (field) => {
      const doc = completion();
      if (field === 'cost') doc.usage.cost = 1;
      else if (field === 'model') doc.model = 'paid';
      else if (field === 'usage') Reflect.deleteProperty(doc, 'usage');
      else Reflect.set(doc.usage.opencode, field, 'bad');
      const s = await setup(doc);
      await expect(s.invoke()).rejects.toThrow('Sin modelo');
      await expect(s.invoke()).rejects.toThrow('Sin modelo');
      expect(s.inner).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['priced', 'endpoint', 'missing', 'data'])(
    'blocks before inference on bad catalog %s',
    async (type) => {
      const cat = catalog();
      const entry = cat.data[0];
      if (!entry) throw new Error('missing fixture');
      if (type === 'priced') entry.cost.text.input.price = 1;
      if (type === 'endpoint') entry.api['chat-completions'].base_url = 'https://other.invalid';
      if (type === 'missing') cat.data = [];
      if (type === 'data') Reflect.deleteProperty(cat, 'data');
      const s = await setup(completion(), cat);
      await expect(s.invoke()).rejects.toThrow();
      expect(s.inner).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses changed destination without transmitting key', async () => {
    const s = await setup();
    await expect(s.fetch('https://other.invalid', { body: '{}' })).rejects.toThrow();
    expect(s.inner).not.toHaveBeenCalled();
  });
  it('refuses changed model', async () => {
    const s = await setup();
    await expect(
      s.fetch(`${s.HY4_BASE}/chat/completions`, { body: '{"model":"paid"}' }),
    ).rejects.toThrow();
    expect(s.inner).not.toHaveBeenCalled();
  });
});

it('rejects a concurrent admission without a second network request', async () => {
  const s = await setup();
  let release: ((value: Response) => void) | undefined;
  s.inner
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json(completion()));
  const first = s.invoke();
  await expect(s.invoke()).rejects.toThrow('ocupado');
  expect(s.inner).toHaveBeenCalledTimes(1);
  release?.(Response.json(catalog()));
  expect((await first).ok).toBe(true);
});

it('forces final usage on SSE so no chunk is released before billing check', async () => {
  const s = await setup(completion(), catalog(), true);
  await s.fetch(`${s.HY4_BASE}/chat/completions`, {
    body: JSON.stringify({ model: s.HY4, stream: true, stream_options: { include_usage: false } }),
  });
  const sent = JSON.parse(String(s.inner.mock.calls[1]?.[1]?.body));
  expect(sent.stream_options.include_usage).toBe(true);
});
