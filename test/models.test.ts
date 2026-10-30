import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ModelCaps, resolveModelCaps } from '../src/core/models.js';

/**
 * Catalogo de contexto/coste y estimador de tokens.
 *
 * Los casos de entorno guardan y restauran las cuatro variables para que un
 * override de un test no cambie el resultado del siguiente.
 */
const ENV_KEYS = [
  'PA_CONTEXT_WINDOW',
  'PA_MAX_OUTPUT_TOKENS',
  'PA_PRICE_INPUT_PER_MTOK',
  'PA_PRICE_OUTPUT_PER_MTOK',
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('resolveModelCaps', () => {
  it('open code usa la ventana de 1M y coste cero por defecto', () => {
    const caps = resolveModelCaps({ providerPreset: 'opencode' });
    expect(caps.id).toBe('space-bunny-free');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutput).toBe(32_000);
    expect(caps.inputPerMTok).toBe(0);
    expect(caps.outputPerMTok).toBe(0);
    expect(caps.supportsImages).toBe(true);
    expect(caps.reasoning).toBe(false);
  });

  it('opencode-local conserva la misma ventana y coste cero', () => {
    const caps = resolveModelCaps({ providerPreset: 'opencode-local' });
    expect(caps.id).toBe('deepseek-v4.1-flash-free');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutput).toBe(32_000);
    expect(caps.inputPerMTok).toBe(0);
    expect(caps.outputPerMTok).toBe(0);
  });

  it('openrouter tiene un preset generico y usa el modelo pedido como id', () => {
    const caps = resolveModelCaps({
      providerPreset: 'openrouter',
      model: 'otro/modelo:free',
    });
    expect(caps.id).toBe('otro/modelo:free');
    expect(caps.contextWindow).toBe(1_048_576);
    expect(caps.maxOutput).toBe(32_000);
    expect(caps.inputPerMTok).toBe(0);
    expect(caps.outputPerMTok).toBe(0);
    expect(caps.supportsImages).toBe(true);
  });

  it('sin config cae en el preset opencode', () => {
    expect(resolveModelCaps()).toMatchObject({
      id: 'space-bunny-free',
      contextWindow: 1_048_576,
    });
  });

  it('infiere el preset desde provider o baseUrl cuando no viene explicito', () => {
    expect(resolveModelCaps({ provider: 'openrouter' }).id).toBe(
      'thinkingmachines/inkling-small:free',
    );
    expect(resolveModelCaps({ baseUrl: 'https://openrouter.ai/api/v1' }).id).toBe(
      'thinkingmachines/inkling-small:free',
    );
    expect(resolveModelCaps({ provider: 'opencode-local' }).id).toBe('deepseek-v4.1-flash-free');
    expect(resolveModelCaps({ baseUrl: 'http://localhost:4096' }).id).toBe(
      'deepseek-v4.1-flash-free',
    );
  });

  it('el entorno anula preset para ventana, salida y precios', () => {
    process.env.PA_CONTEXT_WINDOW = '123456';
    process.env.PA_MAX_OUTPUT_TOKENS = '9000';
    process.env.PA_PRICE_INPUT_PER_MTOK = '2.5';
    process.env.PA_PRICE_OUTPUT_PER_MTOK = '7.5';

    const caps = resolveModelCaps({ providerPreset: 'opencode', model: 'space-bunny-free' });
    expect(caps.contextWindow).toBe(123_456);
    expect(caps.maxOutput).toBe(9_000);
    expect(caps.inputPerMTok).toBe(2.5);
    expect(caps.outputPerMTok).toBe(7.5);
  });

  it('acepta precio cero explicitamente y valores invalidos no rompen el fallback', () => {
    process.env.PA_PRICE_INPUT_PER_MTOK = '0';
    process.env.PA_PRICE_OUTPUT_PER_MTOK = 'no-es-un-numero';
    process.env.PA_CONTEXT_WINDOW = '0';
    const caps = resolveModelCaps({ providerPreset: 'opencode-local' });
    expect(caps.inputPerMTok).toBe(0);
    expect(caps.outputPerMTok).toBe(0);
    expect(caps.contextWindow).toBe(1_048_576);
  });
});
