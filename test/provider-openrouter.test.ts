import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// La clave del vault se controla por test: OpenCode y OpenRouter NO pueden
// compartir secreto, asi que el mock distingue ambas entradas.
vi.mock('../src/vault.js', () => ({
  vaultGet: vi.fn(async (key: string) => {
    if (key === 'provider:apiKey') return 'OPENCODE-SECRET';
    if (key === 'provider:openrouterKey') return VAULT_OR_KEY;
    return null;
  }),
}));

let VAULT_OR_KEY: string | null = null;

const ENV_KEYS = [
  'PA_PROVIDER_PRESET',
  'PA_PROVIDER',
  'PA_MODEL',
  'PA_BASE_URL',
  'OPENROUTER_API_KEY',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  VAULT_OR_KEY = null;
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function freshConfig() {
  const { loadConfig } = await import('../src/config.js');
  return loadConfig();
}

describe('PA_PROVIDER_PRESET', () => {
  it('sin preset, OpenCode Zen free sigue siendo el default', async () => {
    const config = await freshConfig();
    expect(config.providerPreset).toBe('opencode');
    expect(config.provider).toBe('opencode-go');
    expect(config.model).toBe('space-bunny-free');
    expect(config.baseUrl).toBe('https://opencode.ai/zen/v1');
  });

  it('preset openrouter conmuta los tres defaults', async () => {
    process.env.PA_PROVIDER_PRESET = 'openrouter';
    const config = await freshConfig();
    expect(config.providerPreset).toBe('openrouter');
    expect(config.provider).toBe('openrouter');
    expect(config.model).toBe('thinkingmachines/inkling-small:free');
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('PA_MODEL/PA_BASE_URL anulan el preset elegido', async () => {
    process.env.PA_PROVIDER_PRESET = 'openrouter';
    process.env.PA_MODEL = 'otro/modelo:free';
    const config = await freshConfig();
    expect(config.model).toBe('otro/modelo:free');
    expect(config.provider).toBe('openrouter');
  });

  it('preset desconocido falla claro', async () => {
    process.env.PA_PROVIDER_PRESET = 'groq';
    await expect(freshConfig()).rejects.toThrow(/PA_PROVIDER_PRESET/);
  });
});

describe('resolveApiKey con OpenRouter', () => {
  it('no usa la clave de OpenCode y exige una de OpenRouter', async () => {
    // El vault TIENE la clave de OpenCode: si se usara, esto no fallaria.
    process.env.PA_PROVIDER_PRESET = 'openrouter';
    const config = await freshConfig();
    const { createProviderHandle } = await import('../src/core/provider.js');
    await expect(createProviderHandle(config)).rejects.toThrow(/OpenRouter API key/);
  });

  it('acepta OPENROUTER_API_KEY de entorno', async () => {
    process.env.PA_PROVIDER_PRESET = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    const config = await freshConfig();
    const { createProviderHandle } = await import('../src/core/provider.js');
    await expect(createProviderHandle(config)).resolves.toBeDefined();
  });

  it('acepta la clave del vault provider:openrouterKey', async () => {
    process.env.PA_PROVIDER_PRESET = 'openrouter';
    VAULT_OR_KEY = 'or-vault-key';
    const config = await freshConfig();
    const { createProviderHandle } = await import('../src/core/provider.js');
    await expect(createProviderHandle(config)).resolves.toBeDefined();
  });

  it('la ruta OpenCode sigue usando la clave de OpenCode', async () => {
    // Default opencode: el vault tiene provider:apiKey y debe bastar.
    const config = await freshConfig();
    const { createProviderHandle } = await import('../src/core/provider.js');
    await expect(createProviderHandle(config)).resolves.toBeDefined();
  });
});
