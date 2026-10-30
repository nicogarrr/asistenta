import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../src/browser/service.js';
import { createBrowserTool, TARGET_RECHECK_AFTER_MS } from '../src/tools/browser.js';

// Al preguntar, gateHint lee el elemento («Añadir al carrito»). Si Nico tarda en
// aprobar y la página cambia, el mismo selector puede apuntar a otro elemento
// («Pagar ahora»). Antes de actuar se vuelve a leer: si cambió, no se actúa.

function stub(reads: string[]) {
  const clicked: string[] = [];
  let i = 0;
  const svc = {
    describeTarget: async () => reads[Math.min(i++, reads.length - 1)] as string,
    describeContext: async () => '',
    summarisePage: async () => '',
    clickTarget: async (_s: string, sel: string) => {
      clicked.push(sel);
      throw new Error('stop-after-click');
    },
  } as unknown as BrowserService;
  return { tool: createBrowserTool(svc, () => 't'), clicked };
}

describe('clic del navegador: el elemento se vuelve a leer tras una aprobación lenta', () => {
  afterEach(() => vi.restoreAllMocks());

  it('si el elemento cambió durante la espera, no hace clic y lo dice', async () => {
    const { tool, clicked } = stub(['button «Añadir al carrito»', 'button «Pagar ahora»']);
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await tool.gateHint({ action: 'click', selector: '#b' });
    now.mockReturnValue(t0 + TARGET_RECHECK_AFTER_MS + 30_000);
    const r = await tool.execute('id', { action: 'click', selector: '#b' } as never);
    expect(clicked).toEqual([]);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/No he hecho clic/);
    expect(text).toMatch(/Pagar ahora/);
  });

  it('si el elemento es el mismo, el clic sigue', async () => {
    const { tool, clicked } = stub(['button «Añadir al carrito»']);
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await tool.gateHint({ action: 'click', selector: '#b' });
    now.mockReturnValue(t0 + 30_000);
    await tool.execute('id', { action: 'click', selector: '#b' } as never).catch(() => null);
    expect(clicked).toEqual(['#b']);
  });

  it('sin espera (permitido al instante) no relee y hace clic', async () => {
    const { tool, clicked } = stub(['A', 'B']);
    await tool.gateHint({ action: 'click', selector: '#b' });
    await tool.execute('id', { action: 'click', selector: '#b' } as never).catch(() => null);
    expect(clicked).toEqual(['#b']);
  });
});
