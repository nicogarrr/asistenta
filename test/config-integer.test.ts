import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';

// Todos los ajustes num() son cuentas, ms o tokens: un decimal no es un valor válido.
const KEYS = ['PA_RETRY_ATTEMPTS', 'PA_TOOL_TIMEOUT_MS', 'PA_MAX_TOOL_CALLS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfigForTests();
});

describe('ajustes numéricos enteros', () => {
  it('PA_RETRY_ATTEMPTS=2.5 se rechaza al arrancar, como «abc»', () => {
    process.env.PA_RETRY_ATTEMPTS = '2.5';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/PA_RETRY_ATTEMPTS must be a positive integer/);
  });
  it('PA_MAX_TOOL_CALLS=0.5 también', () => {
    process.env.PA_MAX_TOOL_CALLS = '0.5';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/PA_MAX_TOOL_CALLS/);
  });
  it('enteros, también escritos como 1.5e5, siguen valiendo', () => {
    process.env.PA_RETRY_ATTEMPTS = '4';
    process.env.PA_TOOL_TIMEOUT_MS = '1.5e5';
    resetConfigForTests();
    const cfg = loadConfig();
    expect(cfg.toolTimeoutMs).toBe(150_000);
  });
});
