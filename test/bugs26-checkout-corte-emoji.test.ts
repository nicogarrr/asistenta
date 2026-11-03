import { describe, expect, it } from 'vitest';
import type { BrowserService } from '../src/browser/service.js';
import {
  type CheckoutPage,
  createCheckoutPage,
  createCheckoutTool,
} from '../src/tools/checkout.js';

/**
 * Los nombres de botón que se leen de la web se cortaban con slice a ciegas (160/240/400
 * dentro de la página y 80 en el aviso «no pulso "…"»). Un emoji justo en el corte dejaba
 * medio emoji (un sustituto suelto) en lo que lee el modelo, y la API puede rechazar
 * la llamada entera por un texto mal formado. Ahora se corta sin partirlo.
 */
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('checkout: cortes de etiquetas sin partir emojis', () => {
  it('el aviso «no pulso» no parte un emoji a los 80', async () => {
    // «Pagar » (6) + 73 letras = 79: el emoji ocupa las posiciones 79 y 80.
    const label = `Pagar ${'x'.repeat(73)}💳 con tarjeta`;
    const page: CheckoutPage = {
      open: async (url) => ({ url, title: 'Fake' }),
      label: async () => label,
      inspect: async () => ({ label, button: true, formSubmit: '', where: 'https://t.es | T' }),
      fill: async () => {},
      click: async () => {
        throw new Error('no debía pulsar');
      },
      press: async () => {},
      text: async () => '',
      url: async () => 'https://t.es',
      show: async () => true,
    };
    const tool = createCheckoutTool({
      page,
      loadPassenger: async () => null,
      requireApproval: async () => true,
    });
    const err = await tool
      .execute('id', { action: 'select', selector: '#b' } as never, undefined, undefined)
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err?.message).toMatch(/^no pulso "Pagar x+"/);
    expect(err?.message).not.toMatch(LONE);
  });

  it('lo que devuelve la página llega bien formado aunque venga cortado a medias', async () => {
    const cut = `Pagar ${'x'.repeat(153)}\ud83d`;
    let answer = '';
    const service = {
      execJs: async () => ({ text: answer }),
    } as unknown as BrowserService;
    const page = createCheckoutPage(service, () => 'tg:1');
    answer = cut;
    const label = await page.label('#b');
    expect(label).not.toMatch(LONE);
    expect(label.startsWith('Pagar xxx')).toBe(true);
    answer = JSON.stringify({ label: cut, button: true, formSubmit: `Comprar \udc33`, where: 'w' });
    const info = await page.inspect?.('#b');
    expect(info?.label).not.toMatch(LONE);
    expect(info?.formSubmit).not.toMatch(LONE);
    expect(info?.button).toBe(true);
  });
});
