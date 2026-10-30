import { describe, expect, it } from 'vitest';
import { parsePriceToCents, samePrice } from '../src/tools/checkout.js';
import { parseAmount } from '../src/watch/pages.js';
import { parseEuroCents, parseMachinePrice } from '../src/watch/pricewatch.js';

// «1299.99», «1.299,99» y «1,299.99» son el mismo precio en todos los lectores.
const SAME = ['1299.99', '1.299,99', '1,299.99'];

describe('precio con punto decimal: el mismo importe en todos los lectores', () => {
  it('compras (parsePriceToCents / samePrice)', () => {
    for (const s of SAME) expect(parsePriceToCents(s), s).toBe(129999);
    expect(samePrice('1,299.99 €', '1.299,99')).toBe(true);
  });

  it('vigilancias de precio (parseEuroCents)', () => {
    for (const s of SAME) expect(parseEuroCents(`${s} €`), s).toBe(129999);
    expect(parseEuroCents('Precio: 12.5€')).toBe(1250);
    expect(parseEuroCents('Ahora 1,299.99 € (antes 1.499,00 €)')).toBe(129999);
  });

  it('metadatos de la página (parseMachinePrice)', () => {
    for (const s of SAME) expect(parseMachinePrice(s), s).toBe(129999);
  });

  it('páginas vigiladas (parseAmount) ya lo leía bien', () => {
    for (const s of SAME) expect(parseAmount(s), s).toEqual(['1299', '99']);
  });

  it('lo ambiguo o lo que ya era miles no cambia', () => {
    expect(parseEuroCents('1.299 €')).toBe(129900);
    expect(parseEuroCents('1,299 €')).toBeNull();
    expect(parseEuroCents('1.299.99 €')).toBeNull();
    expect(parseEuroCents('1 299.99 €')).toBeNull();
    // Espacio normal: solo es separador de miles con plainSpaceThousands.
    expect(parseEuroCents('1 299,99 €')).toBeNull();
    expect(parseEuroCents('1 299,99 €', { plainSpaceThousands: true })).toBe(129999);
    expect(parseEuroCents('1,299.99 €', { plainSpaceThousands: true })).toBe(129999);
    expect(parsePriceToCents('1,299')).toBeNull();
    expect(parsePriceToCents('1,29.99')).toBeNull();
    expect(parseMachinePrice('1,299')).toBeNull();
  });
});
