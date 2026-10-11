import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let VAULT_KEYS: Record<string, string | null> = {};

vi.mock('../src/vault.js', () => ({
  vaultGet: async (key: string) => VAULT_KEYS[key] ?? null,
}));

const ENV_KEYS = [
  'PA_PROVIDER',
  'PA_MODEL',
  'PA_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'PA_API_KEY',
  'OPENCODE_GO_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  VAULT_KEYS = {};
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('endpoints Google (Gemini)', () => {
  it('usa GEMINI_API_KEY y nunca la clave de OpenCode', async () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    process.env.OPENCODE_GO_API_KEY = 'oc-key';
    const { createProviderHandle } = await import('../src/core/provider.js');
    const handle = await createProviderHandle({
      provider: 'google',
      model: 'gemini-3.8-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    } as never);
    expect(handle.model.compat).toMatchObject({ supportsStore: false });
  });

  it('vault provider:geminiKey tiene prioridad y el error es claro si falta', async () => {
    VAULT_KEYS['provider:geminiKey'] = 'vault-gem';
    const mod = await import('../src/core/provider.js');
    await expect(
      mod.createProviderHandle({
        provider: 'google',
        model: 'gemini-3.8-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      } as never),
    ).resolves.toBeDefined();
    VAULT_KEYS['provider:geminiKey'] = null;
    await expect(
      mod.createProviderHandle({
        provider: 'google',
        model: 'gemini-3.8-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      } as never),
    ).rejects.toThrow('GEMINI_API_KEY');
  });

  it('endpoints no Google no llevan el override de store', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    const { createProviderHandle } = await import('../src/core/provider.js');
    const handle = await createProviderHandle({
      provider: 'openrouter',
      model: 'openrouter/free',
      baseUrl: 'https://openrouter.ai/api/v1',
    } as never);
    expect(handle.model.compat).toBeUndefined();
  });

  it('PA_API_KEY sirve a endpoints custom (Cerebras, vLLM, ...)', async () => {
    process.env.PA_API_KEY = 'custom-key';
    process.env.OPENCODE_GO_API_KEY = 'oc-key';
    const { createProviderHandle } = await import('../src/core/provider.js');
    const handle = await createProviderHandle({
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      baseUrl: 'https://api.cerebras.ai/v1',
    } as never);
    expect(handle.model.compat).toBeUndefined();
  });

  it('la ruta OpenCode sigue intacta sin PA_API_KEY', async () => {
    process.env.OPENCODE_GO_API_KEY = 'oc-key';
    const { createProviderHandle } = await import('../src/core/provider.js');
    const handle = await createProviderHandle({
      provider: 'opencode-go',
      model: 'space-bunny-free',
      baseUrl: 'https://opencode.ai/zen/v1',
    } as never);
    expect(handle.model.compat).toBeUndefined();
  });
});

describe('endpoint custom desconocido (fail-closed)', () => {
  it('sin PA_API_KEY nunca usa la clave de OpenCode contra un tercero', async () => {
    // Repro del auditor #103: vault solo con la clave de OpenCode.
    VAULT_KEYS['provider:apiKey'] = 'opencode-secret';
    delete process.env.PA_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    const { createProviderHandle } = await import('../src/core/provider.js');
    await expect(
      createProviderHandle({
        provider: 'custom',
        model: 'm',
        baseUrl: 'https://third-party.example/v1',
      } as never),
    ).rejects.toThrow('PA_API_KEY');
  });

  it('un falso host Google tampoco recibe la clave de OpenCode', async () => {
    VAULT_KEYS['provider:apiKey'] = 'opencode-secret';
    delete process.env.PA_API_KEY;
    const { createProviderHandle } = await import('../src/core/provider.js');
    await expect(
      createProviderHandle({
        provider: 'custom',
        model: 'm',
        baseUrl: 'https://generativelanguage.googleapis.com.evil.example/v1',
      } as never),
    ).rejects.toThrow('PA_API_KEY');
  });
});
