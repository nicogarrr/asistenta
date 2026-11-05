import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeInBackground } from '../src/core/agent.js';
import { createProviderHandle, utilityModelIds } from '../src/core/provider.js';

// Gap #1 de la comparativa (Crocbot «model roles», Agent Zero «utility model», Hermes
// «auxiliary task fallback»): los resúmenes al compactar y la extracción de hechos
// gastaban el modelo bueno (y su cuota de Go) aunque no son conversación.
const m = (id: string) => ({ id }) as Model<string>;
const reply = (text: string, over: Partial<AssistantMessage> = {}) =>
  ({ content: [{ type: 'text', text }], stopReason: 'stop', ...over }) as AssistantMessage;
const ctx = { messages: [] } as never;

afterEach(() => {
  delete process.env.PA_API_KEY;
});

describe('modelo de fondo (PA_UTILITY_MODEL)', () => {
  it('el resumen va al modelo barato; el principal no se toca', async () => {
    const complete = vi.fn(async (_m: Model<string>) => reply('resumen'));
    const out = await completeInBackground(complete, m('barato'), m('bueno'), ctx);
    expect(out.content[0]).toMatchObject({ text: 'resumen' });
    expect(complete.mock.calls.map((c) => c[0].id)).toEqual(['barato']);
  });

  it('si el barato falla, da error o vuelve vacío, lo hace el principal', async () => {
    for (const fallo of [
      async () => {
        throw new Error('429 quota');
      },
      async () => reply('', { stopReason: 'error', errorMessage: '503' }),
      async () => reply('   '),
    ]) {
      const complete = vi.fn(async (model: Model<string>) =>
        model.id === 'barato' ? fallo() : reply('del bueno'),
      );
      const out = await completeInBackground(complete, m('barato'), m('bueno'), ctx);
      expect(out.content[0]).toMatchObject({ text: 'del bueno' });
      expect(complete.mock.calls.map((c) => c[0].id)).toEqual(['barato', 'bueno']);
    }
  });

  it('sin PA_UTILITY_MODEL, todo con el principal como antes; un aborto no se reintenta', async () => {
    const complete = vi.fn(async (_m: Model<string>) => reply('x'));
    await completeInBackground(complete, undefined, m('bueno'), ctx);
    expect(complete.mock.calls.map((c) => c[0].id)).toEqual(['bueno']);

    const ac = new AbortController();
    ac.abort();
    const aborta = vi.fn(async () => {
      throw new Error('aborted');
    });
    await expect(
      completeInBackground(aborta, m('barato'), m('bueno'), ctx, { signal: ac.signal }),
    ).rejects.toThrow('aborted');
    expect(aborta).toHaveBeenCalledTimes(1);
  });

  it('el proveedor registra el modelo barato y lo ofrece como utilityFor', async () => {
    process.env.PA_API_KEY = 'clave-de-prueba';
    expect(utilityModelIds({ model: 'a', utilityModel: 'a' })).toEqual([]);
    expect(utilityModelIds({ model: 'a', utilityModel: ' c ' })).toEqual(['c']);
    const handle = await createProviderHandle({
      provider: 'custom',
      model: 'principal',
      utilityModel: 'barato-free',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_000,
    } as never);
    expect(handle.utilityFor?.('s').id).toBe('barato-free');
    const sin = await createProviderHandle({
      provider: 'custom',
      model: 'principal',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindowTokens: 128_000,
      maxOutputTokens: 4_000,
    } as never);
    expect(sin.utilityFor).toBeUndefined();
  });
});
