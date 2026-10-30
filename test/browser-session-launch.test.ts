import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ launches: 0, closes: 0, failInit: false }));

function fake(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop in target) return target[prop as string];
      return () => Promise.resolve(undefined);
    },
  });
}

vi.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: async () => {
      state.launches++;
      await new Promise((r) => setTimeout(r, 20));
      const page = fake({
        on: () => undefined,
        url: () => 'about:blank',
        title: async () => '',
        goBack: async () => null,
      });
      return fake({
        pages: () => (state.failInit ? [] : [page]),
        newPage: async () => {
          throw new Error('new page failed');
        },
        setDefaultTimeout: () => undefined,
        setDefaultNavigationTimeout: () => undefined,
        on: () => undefined,
        close: async () => {
          state.closes++;
        },
      });
    },
  },
}));

const { BrowserService } = await import('../src/browser/service.js');

describe('browser session launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-launch-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const make = () =>
    new BrowserService({
      policy: { approve: async () => true },
      profilesDir: join(root, 'profiles'),
      channel: 'chromium',
    });

  beforeEach(() => {
    state.launches = 0;
    state.closes = 0;
    state.failInit = false;
  });

  it('two calls at once for one chat launch ONE browser', async () => {
    const service = make();
    await Promise.all([service.back('t#1'), service.back('t#1'), service.back('t#1')]);
    expect(state.launches).toBe(1);
    await service.closeAll();
    expect(state.closes).toBe(1);
  });

  it('a launch whose setup fails closes the browser instead of leaking it', async () => {
    const service = make();
    state.failInit = true;
    await expect(service.back('t#2')).rejects.toThrow(/new page failed/);
    expect(state.closes).toBe(1);
  });
});
