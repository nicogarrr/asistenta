import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Consumo: un Chromium sin ventana abierto «por si acaso» son varios procesos, cientos de MB
// y un sondeo de anuncios cada segundo durante todo el día. Tras un rato sin uso se cierra
// solo; las ventanas visibles nunca.
const state = vi.hoisted(() => ({ launches: 0, closes: 0, url: 'https://example.com/pagina' }));

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
      const page = fake({
        on: () => undefined,
        url: () => state.url,
        title: async () => 'Página',
        evaluate: async () => ({ playing: false }),
        isClosed: () => false,
      });
      return fake({
        pages: () => [page],
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

const { BrowserService, BROWSER_IDLE_CLOSE_MS } = await import('../src/browser/service.js');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('consumo: navegador sin ventana se cierra tras un rato sin uso', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-consumo1-nav-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const make = (idleCloseMs?: number, approve: () => Promise<boolean> = async () => true) =>
    new BrowserService({
      policy: { approve, adSkipIntervalMs: 0 },
      profilesDir: join(root, `p${Math.random()}`),
      channel: 'chromium',
      headless: true,
      idleCloseMs,
    });

  beforeEach(() => {
    state.launches = 0;
    state.closes = 0;
  });

  it('por defecto son 10 minutos', () => {
    expect(BROWSER_IDLE_CLOSE_MS).toBe(10 * 60_000);
  });

  it('sin uso se cierra solo y el Chromium se apaga', async () => {
    const svc = make(80);
    await svc.mediaState('chat-1').catch(() => undefined);
    expect(svc.isOpen('chat-1')).toBe(true);
    await wait(260);
    expect(svc.isOpen('chat-1')).toBe(false);
    expect(state.closes).toBe(1);
  });

  it('mientras se usa no se cierra', async () => {
    const svc = make(150);
    await svc.mediaState('chat-2').catch(() => undefined);
    for (let i = 0; i < 6; i++) {
      await wait(50);
      await svc.mediaState('chat-2').catch(() => undefined);
    }
    expect(svc.isOpen('chat-2')).toBe(true);
    expect(state.launches).toBe(1);
    await svc.closeAll();
  });

  it('una ventana visible (vídeo) no se cierra nunca', async () => {
    const svc = make(60);
    await svc.execJs('chat-3', '1', { visible: true }).catch(() => undefined);
    expect(svc.isVisible('chat-3')).toBe(true);
    await wait(250);
    expect(svc.isOpen('chat-3')).toBe(true);
    await svc.closeAll();
  });

  it('0 lo desactiva', async () => {
    const svc = make(0);
    await svc.mediaState('chat-4').catch(() => undefined);
    await wait(150);
    expect(svc.isOpen('chat-4')).toBe(true);
    await svc.closeAll();
  });

  it('al reabrir avisa de que se cerró y de la última página', async () => {
    const svc = make(60);
    await svc.mediaState('chat-5').catch(() => undefined);
    await wait(220);
    expect(svc.isOpen('chat-5')).toBe(false);
    const r = await svc.open('chat-5', 'https://example.com/otra').catch((e: unknown) => e);
    const note = (r as { note?: string }).note ?? '';
    expect(note).toContain('sin uso');
    expect(note).toContain('https://example.com/pagina');
    await svc.closeAll();
  });
});
