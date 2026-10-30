import { describe, expect, it } from 'vitest';
import { findScreenFindings, redact } from '../src/ojo-screen.js';

/**
 * El ojo de pantalla redacta cada línea antes de guardarla o enviarla. La regla de
 * «código»/«PIN» ocultaba lo que va DESPUÉS de la palabra, pero un código escrito
 * ANTES («123456 es tu código para confirmar el pago de 49,99 €», el SMS típico del
 * banco al pagar, o «G-482913 es tu código de verificación») quedaba a la vista.
 */
describe('ojo-screen · redact oculta el código aunque vaya antes de la palabra', () => {
  it('SMS de pago del banco', () => {
    const out = redact('123456 es tu código para confirmar el pago de 49,99 € en TIENDA');
    expect(out).not.toContain('123456');
  });

  it('código de Google con prefijo', () => {
    expect(redact('G-482913 es tu código de verificación de Google')).not.toContain('482913');
  });

  it('en inglés y con PIN', () => {
    expect(redact('Use 7731 as your PIN for the payment')).not.toContain('7731');
    expect(redact('9921 is your verification code')).not.toContain('9921');
  });

  it('la línea sigue siendo un hallazgo pero sin el código', () => {
    const f = findScreenFindings(['Banco: 554433 es tu código para el pago de 120,00 € a ACME']);
    expect(JSON.stringify(f)).not.toContain('554433');
  });

  it('sin palabra de código, importes y fechas se quedan (caracterización)', () => {
    expect(redact('Factura de luz: total 1.234,56 € vence el 15/11/2026')).toContain('1.234,56');
    expect(redact('Factura de luz: total 1.234,56 € vence el 15/11/2026')).toContain('15/11/2026');
    expect(redact('Recibo 2026 de 49,99 €')).toContain('2026');
  });
});
