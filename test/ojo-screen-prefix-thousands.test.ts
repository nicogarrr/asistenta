import { describe, expect, it } from 'vitest';
import { findScreenFindings } from '../src/ojo-screen.js';

// Importe con el símbolo delante y miles con espacio (duro, estrecho, fino o normal):
// sin fecha en la línea, era lo único que la hacía aviso y no se reconocía.
describe('ojo pantalla: importe con símbolo delante y miles con espacio', () => {
  for (const sep of ['\u00a0', '\u202f', '\u2009', ' ']) {
    const cp = sep.codePointAt(0)?.toString(16);
    it(`«Total a pagar: € 1${cp}299,00» es un aviso`, () => {
      expect(findScreenFindings([`Total a pagar: € 1${sep}299,00`])).toHaveLength(1);
      expect(findScreenFindings([`Importe del recibo EUR 12${sep}345,50`])).toHaveLength(1);
    });
  }

  it('lo de antes sigue igual', () => {
    expect(findScreenFindings(['Total a pagar: €1.299,00'])).toHaveLength(1);
    expect(findScreenFindings(['Total a pagar: 1.234,50 €'])).toHaveLength(1);
    expect(findScreenFindings(['Su factura está lista'])).toHaveLength(0);
    expect(findScreenFindings(['€ 1 299 sin contexto de pago'])).toHaveLength(0);
  });
});
