import { describe, expect, it } from 'vitest';
import { providerKeySource } from '../src/llm-health.js';

/** `pa doctor` → «provider key»: busca la clave del endpoint configurado, no siempre la de OpenCode. */
const vault =
  (keys: Record<string, string>) =>
  async (k: string): Promise<string | undefined> =>
    keys[k];

describe('providerKeySource (pa doctor)', () => {
  it('OpenCode: provider:apiKey del almacén', async () => {
    const r = await providerKeySource('https://opencode.ai/zen/v1', {
      getKey: vault({ 'provider:apiKey': 'k' }),
      env: {},
    });
    expect(r.source).toBe('vault');
  });

  it('OpenRouter con su clave guardada ya no sale «unset»', async () => {
    const r = await providerKeySource('https://openrouter.ai/api/v1', {
      getKey: vault({ 'provider:openrouterKey': 'k' }),
      env: {},
    });
    expect(r.source).toBe('vault');
  });

  it('OpenRouter con solo la clave de OpenCode: falta, y dice cómo ponerla', async () => {
    const r = await providerKeySource('https://openrouter.ai/api/v1', {
      getKey: vault({ 'provider:apiKey': 'k' }),
      env: { OPENCODE_GO_API_KEY: 'x' },
    });
    expect(r).toEqual({
      source: 'unset',
      hint: 'pa vault set-stdin provider:openrouterKey: te la pide sin que se vea',
    });
  });

  it('OpenCode sin clave: manda a instalar.bat y nunca a escribir la clave en la consola', async () => {
    const r = await providerKeySource('https://opencode.ai/zen/v1', { getKey: vault({}), env: {} });
    expect(r.source).toBe('unset');
    expect(r.hint).toContain('instalar.bat');
    expect(r.hint).toContain('set-stdin provider:apiKey');
    expect(r.hint).not.toMatch(/vault set |<clave>/);
  });

  it('Gemini por variable de entorno', async () => {
    const r = await providerKeySource('https://generativelanguage.googleapis.com/v1beta/openai', {
      getKey: vault({}),
      env: { GOOGLE_API_KEY: 'g' },
    });
    expect(r.source).toBe('env');
  });

  it('endpoint propio: solo PA_API_KEY', async () => {
    const r = await providerKeySource('http://127.0.0.1:1234/v1', {
      getKey: vault({ 'provider:apiKey': 'k' }),
      env: {},
    });
    expect(r).toEqual({ source: 'unset', hint: 'PA_API_KEY en .env' });
  });
});
