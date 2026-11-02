import { describe, expect, it, vi } from 'vitest';
import { createPurchaseApprovals } from '../src/daemon/purchase-approvals.js';
import { type CheckoutPage, createCheckoutTool } from '../src/tools/checkout.js';

/**
 * La pregunta de una compra va ligada a la vida del turno, igual que las de los
 * especialistas (#1757): si Nico dice /stop o el turno se corta, la señal del turno llega
 * a la pregunta de Telegram, que se deniega y se queda sin botones. Solo puede denegar
 * antes; nunca permite nada.
 */
function page(body: string): CheckoutPage {
  return {
    open: async (url) => ({ url, title: 't' }),
    label: async () => '',
    fill: async () => {},
    click: async () => {},
    press: async () => {},
    text: async () => body,
    url: async () => 'https://shop.example/cart',
    show: async () => true,
  };
}

describe('compra: la señal del turno llega a la pregunta', () => {
  it('checkout pasa la señal de la herramienta a requireApproval', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const requireApproval = vi.fn(async (_a: string, _s: string, signal?: AbortSignal) => {
      seen.push(signal);
      return false;
    });
    const tool = createCheckoutTool({ page: page('Total 25,00 EUR'), requireApproval });
    const turn = new AbortController();
    await tool.execute(
      'id',
      { action: 'confirm', item: 'pizza', price: '25,00' } as never,
      turn.signal,
      undefined,
    );
    expect(requireApproval).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([turn.signal]);
  });

  it('createPurchaseApprovals pasa la señal a la pregunta humana', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const p = createPurchaseApprovals();
    const turn = new AbortController();
    const human = async (_q: string, signal?: AbortSignal) => {
      seen.push(signal);
      return true;
    };
    await expect(p.ask('t', 'checkout:confirm', '¿Pagar 20 €?', human, turn.signal)).resolves.toBe(
      true,
    );
    expect(seen).toEqual([turn.signal]);
  });

  it('con el turno ya cortado no pregunta: denegada', async () => {
    const human = vi.fn(async () => true);
    const p = createPurchaseApprovals();
    const turn = new AbortController();
    turn.abort();
    await expect(p.ask('t', 'checkout:confirm', 'x', human, turn.signal)).resolves.toBe(false);
    expect(human).not.toHaveBeenCalled();
  });

  it('cli.ts lleva la señal de la compra hasta la pregunta de Telegram', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain(
      'requireApproval: (action, summary, signal) => askCheckout(thread, action, summary, signal)',
    );
    expect(src).toContain('askOncePerTurn(thread, q, s)');
  });
});
