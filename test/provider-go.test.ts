import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import {
  CLIENT_USER_AGENT,
  createProviderHandle,
  goHeaders,
  isGoEndpoint,
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

  it('defaults to the Zen endpoint with the free space-bunny model', () => {
    // Measured 2026-10-07: space-bunny-free answers 200 on zen/v1 (~2 s) and 400
    // "Model is unavailable" on zen/go/v1; LongCat only runs on Go and is slow.
    const c = loadConfig();
    expect(c.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(c.model).toBe('space-bunny-free');
    expect(isGoEndpoint(c.baseUrl)).toBe(false);
    expect(isOpenCodeEndpoint(c.baseUrl)).toBe(true);
  });

  it('only treats the Go path as Go', () => {
    expect(isGoEndpoint('https://opencode.ai/zen/v1')).toBe(false);
    expect(isGoEndpoint('https://opencode.ai/zen/go')).toBe(true);
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
