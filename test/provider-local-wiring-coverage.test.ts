import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/core/opencode-local.js', () => ({
  DEFAULT_OPENCODE_LOCAL: {},
  createOpenCodeLocalStream: () => () => ({
    result: async () => ({ role: 'assistant', content: [], stopReason: 'stop' }),
  }),
}));

import { loadConfig, resetConfigForTests } from '../src/config.js';
import { createProviderHandle } from '../src/core/provider.js';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  resetConfigForTests();
});
it('routes local stream and same-provider summary through the local adapter', async () => {
  process.env.PA_PROVIDER_PRESET = 'opencode-local';
  delete process.env.PA_MODEL;
  delete process.env.PA_BASE_URL;
  resetConfigForTests();
  const h = await createProviderHandle(loadConfig());
  const streamed = await h.streamFn(h.model, { messages: [] }).result();
  expect(streamed.role).toBe('assistant');
  const completed = await h.models.completeSimple(h.model, { messages: [] });
  expect(completed.role).toBe('assistant');
});
