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

const { createAttentionJudge } = await import('../src/core/attention-model.js');

const event = { source: 'mail', text: 'hola' } as never;
const signal = new AbortController().signal;

beforeEach(() => {
  createProviderHandle.mockClear();
  completeSimple.mockReset();
  completeSimple.mockResolvedValue({ content: [{ type: 'text', text: '{"relevant":false}' }] });
});

describe('filtro de atención: un modelo de reserva vacío nunca se envía como modelo', () => {
  it.each([
    [
      'openrouter',
      { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta/llama:free' },
    ],
    [
      'opencode-local',
      { provider: 'opencode-local', baseUrl: 'http://127.0.0.1:4096/v1', model: 'big-pickle-free' },
    ],
  ])('%s: fallbackModel vacío → el cribado usa el modelo principal gratuito', async (_n, base) => {
    const judge = createAttentionJudge({ ...base, fallbackModel: '' } as unknown as Config);
    await judge('screen', event, signal);
    expect(createProviderHandle.mock.calls[0]?.[0]?.model).toBe(base.model);
  });

  it('con reserva gratuita sigue usándola para el cribado', async () => {
    const judge = createAttentionJudge({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta/llama:free',
      fallbackModel: 'small/x:free',
    } as unknown as Config);
    await judge('screen', event, signal);
    expect(createProviderHandle.mock.calls[0]?.[0]?.model).toBe('small/x:free');
  });
});
