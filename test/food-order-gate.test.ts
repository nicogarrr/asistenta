import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/core/prompt.js';
import { isPaymentText } from '../src/permissions.js';
import { looksLikePaymentSubmission } from '../src/tools/checkout.js';

// Synthetic button labels: no site, no order, no spend. They pin that the last click of a
// delivery order, including pay-on-delivery, still reads as a commitment that needs the user.
describe('delivery order: last click stays behind the gate', () => {
  const submit = [
    'Hacer pedido',
    'Pedir ahora',
    'Realizar pedido',
    'Finalizar pedido',
    'Place order',
    'Pagar al recibir',
    'Pago en efectivo al recibir',
    'Pedir a domicilio',
  ];
  it.each(submit)('"%s" is a payment submission', (label) => {
    expect(looksLikePaymentSubmission(label)).toBe(true);
    expect(isPaymentText(label)).toBe(true);
  });
  it('"Submit order" is caught by the checkout button check', () => {
    expect(looksLikePaymentSubmission('Submit order')).toBe(true);
  });
  it('ordinary cart navigation is not blocked', () => {
    for (const label of ['Añadir al carrito', 'Ver carrito', 'Continuar', 'Ir a la cesta']) {
      expect(looksLikePaymentSubmission(label)).toBe(false);
    }
  });
});

describe('prompt keeps the order rules', () => {
  it('asks only what is missing, treats pay-on-delivery as a commitment, reports only what the page shows', () => {
    expect(SYSTEM_PROMPT).toContain('on any site');
    expect(SYSTEM_PROMPT).toContain('Ask only what is missing');
    expect(SYSTEM_PROMPT).toContain('Paying later or on delivery is still a commitment');
    expect(SYSTEM_PROMPT).toContain('report only what the confirmation or tracking page shows');
  });
});

describe('prompt: current facts need a source', () => {
  it('asks for the web tool, the source URL and an honest not-found', () => {
    expect(SYSTEM_PROMPT).toContain('never from memory');
    expect(SYSTEM_PROMPT).toContain('the source URL you read');
    expect(SYSTEM_PROMPT).toContain('date or period matches what was asked');
    expect(SYSTEM_PROMPT).toContain('no lo he encontrado');
  });
});
