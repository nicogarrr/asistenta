import { describe, expect, it } from 'vitest';
import { isPaymentText } from '../src/permissions.js';
import { looksLikePaymentSubmission } from '../src/tools/checkout.js';

// Synthetic labels only. Adversarial spellings of "place the order": accents, case,
// punctuation, a price in the label, and other languages.
const MUST_ASK = [
  'Encargar',
  'ENCARGAR',
  'Encargar ahora',
  'Encargar (36,00 CHF)',
  'Hacer encargo',
  'Encárgalo',
  '¡Encargar!',
  'Solicitar pedido',
  'Bestellen',
  'Jetzt bestellen',
  'Bestellung abschicken',
  'Jetzt kaufen',
  'Bezahlen',
  'Commander',
  'Passer la commande',
  'Payer maintenant',
  'Acheter',
  'Ordina ora',
  'Acquista',
];
const MUST_NOT_BLOCK = [
  'Añadir al carrito',
  'Ver carrito',
  'Continuar',
  'Buscar',
  'Siguiente página',
  'Ir a la cesta',
  'Volver',
  'Encargado de tienda',
];

describe('order verbs stay behind the gate', () => {
  it.each(MUST_ASK)('"%s" asks', (label) => {
    expect(isPaymentText(label)).toBe(true);
    expect(looksLikePaymentSubmission(label)).toBe(true);
  });
  it.each(MUST_NOT_BLOCK)('"%s" is not a payment click', (label) => {
    expect(looksLikePaymentSubmission(label)).toBe(false);
  });
});
