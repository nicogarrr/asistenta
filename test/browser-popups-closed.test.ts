import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type FakePage = { closed: boolean; isClosed: () => boolean; close: () => Promise<void> };
const state = vi.hoisted(() => ({ pages: [] as FakePage[] }));

function fake(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (prop in target) return target[prop as string];
      return () => Promise.resolve(undefined);
    },
  });
}

function makePage(): FakePage {
  const p = fake({
    closed: false,
    on: () => undefined,
    url: () => 'about:blank',
    title: async () => '',
    evaluate: async () => ({ playing: false }),
    isClosed: () => p.closed,
    close: async () => {
      p.closed = true;
      state.pages = state.pages.filter((x) => x !== p);
    },
  }) as FakePage;
  return p;
}

vi.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: async () => {
      state.pages = [makePage()];
      return fake({
        pages: () => [...state.pages],
        setDefaultTimeout: () => undefined,
        setDefaultNavigationTimeout: () => undefined,
        on: () => undefined,
        close: async () => undefined,
      });
    },
  },
}));

const { BrowserService } = await import('../src/browser/service.js');

describe('browser: pestañas emergentes que abre la web', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-popups-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const make = () =>
    new BrowserService({
      policy: { approve: async () => true },
      profilesDir: join(root, 'profiles'),
      channel: 'chromium',
      headless: true,
    });

  beforeEach(() => {
    state.pages = [];
  });

  it('se cierran antes del siguiente paso y la página principal sigue', async () => {
    const svc = make();
    await svc.mediaState('chat-1').catch(() => undefined);
    const main = state.pages[0] as FakePage;
    const popA = makePage();
    const popB = makePage();
    state.pages.push(popA, popB); // window.open / target=_blank durante el paso
    await svc.mediaState('chat-1').catch(() => undefined);
    expect(popA.closed).toBe(true);
    expect(popB.closed).toBe(true);
    expect(main.closed).toBe(false);
    expect(state.pages.length).toBe(1);
    expect(state.pages[0]).toBe(main);
  });

  it('si la principal ya está cerrada no se cierra nada más', async () => {
    const svc = make();
    await svc.mediaState('chat-2').catch(() => undefined);
    const main = state.pages[0] as FakePage;
    const pop = makePage();
    state.pages.push(pop);
    main.closed = true;
    await svc.mediaState('chat-2').catch(() => undefined);
    expect(pop.closed).toBe(false);
  });
});
