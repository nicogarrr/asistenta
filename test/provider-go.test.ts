import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import {
  CLIENT_USER_AGENT,
  createProviderHandle,
  goHeaders,
  isOpenCodeEndpoint,
} from '../src/core/provider.js';

describe('OpenCode Go client rules', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.OPENCODE_GO_API_KEY = 'test-key-no-network';
    delete process.env.PA_MODEL;
    delete process.env.PA_BASE_URL;
    // Un endpoint de terceros exige PA_API_KEY explicita (la clave de OpenCode
    // nunca se manda fuera), asi que se borra para que cada test declare la
    // suya en vez de heredarla.
    delete process.env.PA_API_KEY;
    resetConfigForTests();
  });
  afterEach(() => {
    process.env = { ...prev };
    resetConfigForTests();
  });

  it('defaults to OpenCode Go with DeepSeek V4.1 Flash', () => {
    // Decision de Nico (2026-11-02): «DeepSeek V4 flash normal, el de open code
    // y no local». Medido ese dia: deepseek-v4.1-flash responde 200 en
    // zen/go/v1 con coste 0 (dentro de la suscripcion Go); zen/v1 exige balance
    // («Insufficient account funds») y Nico no tiene. Antes: zen/v1 +
    // space-bunny-free (medido 2026-10-07), inservible sin balance Zen.
    const c = loadConfig();
    expect(c.provider).toBe('opencode-go');
    expect(c.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(c.model).toBe('deepseek-v4.1-flash');
    expect(isOpenCodeEndpoint(c.baseUrl)).toBe(true);
  });

  it('sends an own user agent and the session id', () => {
    expect(goHeaders('pa-x')).toEqual({
      'User-Agent': CLIENT_USER_AGENT,
      'x-opencode-session': 'pa-x',
    });
    expect(goHeaders(undefined)).toEqual({ 'User-Agent': CLIENT_USER_AGENT });
  });

  it('modelFor adds the client headers on Zen and on Go, none elsewhere', async () => {
    const zen = await createProviderHandle(loadConfig());
    expect(zen.modelFor('pa-1').headers?.['x-opencode-session']).toBe('pa-1');
    expect(zen.modelFor('pa-1').headers?.['User-Agent']).toBe(CLIENT_USER_AGENT);
    process.env.PA_BASE_URL = 'https://opencode.ai/zen/go/v1';
    resetConfigForTests();
    const go = await createProviderHandle(loadConfig());
    expect(go.modelFor('pa-2').headers?.['x-opencode-session']).toBe('pa-2');
    process.env.PA_BASE_URL = 'https://example.test/v1';
    // Endpoint de terceros: la clave de OpenCode no se envia ahi, asi que hace
    // falta una propia o la construccion falla cerrada antes de llegar a esto.
    process.env.PA_API_KEY = 'test-third-party-no-network';
    resetConfigForTests();
    const other = await createProviderHandle(loadConfig());
    expect(other.modelFor('pa-3').headers?.['x-opencode-session']).toBeUndefined();
  });
});
