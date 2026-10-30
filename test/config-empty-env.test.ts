import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';

// Una línea vacía en el .env (`PA_MODEL=`) debe valer «no definido», como en num/flag/oneOf.
const KEYS = ['PA_PROVIDER_PRESET', 'PA_PROVIDER', 'PA_MODEL', 'PA_BASE_URL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfigForTests();
});

describe('variables de entorno vacías', () => {
  it('PA_PROVIDER_PRESET vacío usa el preset por defecto en vez de abortar el arranque', () => {
    process.env.PA_PROVIDER_PRESET = '';
    resetConfigForTests();
    expect(loadConfig().providerPreset).toBe('opencode');
  });

  it('PA_MODEL, PA_BASE_URL y PA_PROVIDER vacíos o en blanco caen al preset', () => {
    process.env.PA_PROVIDER_PRESET = 'openrouter';
    process.env.PA_MODEL = '';
    process.env.PA_BASE_URL = '   ';
    process.env.PA_PROVIDER = '';
    resetConfigForTests();
    const c = loadConfig();
    expect(c.model).toBe('thinkingmachines/inkling-small:free');
    expect(c.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(c.provider).toBe('openrouter');
  });

  it('el preset admite mayúsculas y espacios, como el resto de opciones cerradas', () => {
    process.env.PA_PROVIDER_PRESET = ' OpenRouter ';
    resetConfigForTests();
    expect(loadConfig().providerPreset).toBe('openrouter');
  });

  it('un preset desconocido sigue siendo un error', () => {
    process.env.PA_PROVIDER_PRESET = 'otro';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/PA_PROVIDER_PRESET/);
  });
});
