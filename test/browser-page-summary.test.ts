import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { pageSummary } from '../src/browser/target.js';

/**
 * pageSummary with a fake Page (no browser): the in-page function runs here
 * against a stub `document`.
 */
const g = globalThis as { document?: unknown };
afterEach(() => {
  delete g.document;
});

function pageWithText(text: string): Page {
  return {
    evaluate: async (fn: () => unknown) => {
      g.document = { body: { innerText: text } };
      return fn();
    },
  } as unknown as Page;
}

describe('pageSummary', () => {
  it('respeta su timeout: una página colgada no bloquea la confirmación de pago', async () => {
    const hung = { evaluate: () => new Promise(() => {}) } as unknown as Page;
    const t0 = Date.now();
    const out = await Promise.race([
      pageSummary(hung, 100),
      new Promise<string>((r) => setTimeout(() => r('SIGUE-COLGADA'), 3_000)),
    ]);
    expect(out).toBe('');
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it('un fallo de la página da cadena vacía', async () => {
    const broken = {
      evaluate: async () => Promise.reject(new Error('target closed')),
    } as unknown as Page;
    expect(await pageSummary(broken, 100)).toBe('');
  });

  it('muestra importes en dólares, libras y códigos ISO, no solo euros', async () => {
    const out = await pageSummary(
      pageWithText('Carrito\nTotal: $49.99\nShipping £5\nUSD 12 tax\nGracias por su compra'),
    );
    expect(out.split('\n')).toEqual(['Total: $49.99', 'Shipping £5', 'USD 12 tax']);
  });

  it('sigue mostrando euros y la dirección; sin duplicados', async () => {
    const out = await pageSummary(
      pageWithText('Subtotal 20,00 €\nCalle Mayor 1\nSubtotal 20,00 €\nhola'),
    );
    expect(out.split('\n')).toEqual(['Subtotal 20,00 €', 'Calle Mayor 1']);
  });
});
