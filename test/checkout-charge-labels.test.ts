import { describe, expect, it } from 'vitest';
import { looksLikePaymentSubmission } from '../src/tools/checkout.js';

describe('checkout: labels that commit money are refused', () => {
  // Each of these is the last button of a real booking, donation or order flow on a page
  // whose URL does not say "checkout", so only the label stands between it and a charge.
  for (const label of [
    'Book now',
    'Reserve now',
    'Complete booking',
    'Confirm reservation',
    'Donate',
    'Donate 10 €',
    'Adquirir',
    'Order',
    'Submit',
  ]) {
    it(label, () => {
      expect(looksLikePaymentSubmission(label)).toBe(true);
    });
  }

  it('ordinary navigation still passes', () => {
    for (const label of ['Order history', 'Sort order', 'Continuar al pago', 'Ver producto']) {
      expect(looksLikePaymentSubmission(label), label).toBe(false);
    }
  });
});
