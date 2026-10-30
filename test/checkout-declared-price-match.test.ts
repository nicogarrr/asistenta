import { describe, expect, it } from 'vitest';
import { samePrice } from '../src/tools/checkout.js';

// El aviso «Ojo: tu lees X y la pagina marca Y» comparaba textos: la página guarda
// «1 299,00» como «1299,00» (sin espacios, con puntos si los había), así que
// «1.299,00 €» frente a «1 299,00 €» avisaba de una diferencia que no existe.
describe('checkout confirm: el precio declarado se compara como importe, no como texto', () => {
  it('mismo importe con distinto formato no es diferencia', () => {
    expect(samePrice('1.299,00 €', '1299,00')).toBe(true);
    expect(samePrice('1299', '1.299,00')).toBe(true);
    expect(samePrice('EUR 1 299,00', '1.299,00')).toBe(true);
    expect(samePrice('45,2 €', '45,20')).toBe(true);
    expect(samePrice('45,20€', '45,20')).toBe(true);
  });

  it('importes distintos siguen avisando', () => {
    expect(samePrice('1.299,00 €', '1299,99')).toBe(false);
    expect(samePrice('299 €', '1.299,00')).toBe(false);
  });

  it('lo que no se puede leer cuenta como diferente (avisar es lo seguro)', () => {
    expect(samePrice('unos mil euros', '1.299,00')).toBe(false);
    expect(samePrice('', '1.299,00')).toBe(false);
  });
});
