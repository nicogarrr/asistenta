import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import {
  CLIENT_USER_AGENT,
  createProviderHandle,
  goHeaders,
  isGoEndpoint,
} from '../src/core/provider.js';

describe('OpenCode Go client rules', () => {
  const prev = { ...process.env };
  beforeEach(() => {
    process.env.OPENCODE_GO_API_KEY = 'test-key-no-network';
    delete process.env.PA_MODEL;
    delete process.env.PA_BASE_URL;
    resetConfigForTests();
  });
  afterEach(() => {
    process.env = { ...prev };
    resetConfigForTests();
  });

  it('defaults to the Go endpoint with the free LongCat model', () => {
    const c = loadConfig();
    expect(c.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(c.model).toBe('longcat-2.5-preview-free');
    expect(isGoEndpoint(c.baseUrl)).toBe(true);
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

  it('modelFor adds headers on Go and none on Zen', async () => {
    const go = await createProviderHandle(loadConfig());
    expect(go.modelFor('pa-1').headers?.['x-opencode-session']).toBe('pa-1');
    process.env.PA_BASE_URL = 'https://opencode.ai/zen/v1';
    resetConfigForTests();
    const zen = await createProviderHandle(loadConfig());
    expect(zen.modelFor('pa-1').headers?.['x-opencode-session']).toBeUndefined();
  });
});
