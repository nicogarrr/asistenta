import { describe, expect, it } from 'vitest';
import { findScreenFindings, isExcludedWindow, redact } from '../src/ojo-screen.js';

/**
 * Ojo de águila, pantalla: auditoría de seguridad (solo más estricto).
 * Caracterización: lo que hoy se conserva o se oculta sigue igual.
 * Huecos cerrados: códigos de verificación en inglés, fecha de nacimiento, URLs «www.…»,
 * prefijo visible de claves tipo «sk-…», diálogos de credenciales de Windows y más
 * bancos/brókers/trámites en la lista de exclusión.
 */
describe('ojo pantalla — caracterización (sin cambios)', () => {
  const same: Array<[string, string]> = [
    ['pago 1.234,56 € el 05/11/2026', 'pago 1.234,56 € el 05/11/2026'],
    ['Total a pagar 1.234.567,89 €', 'Total a pagar 1.234.567,89 €'],
    ['vence 12.05.2026 15.30', 'vence 12.05.2026 15.30'],
    ['Tel 612 34 56 78 pago 12,50 €', 'Tel [oculto] pago 12,50 €'],
    ['Tarjeta 4111 1111 1111 1111 cargo 5 €', 'Tarjeta [oculto] cargo 5 €'],
    ['IBAN ES91 2100 0418 4502 0005 1332 recibo 30 €', 'IBAN [oculto] 30 €'],
    ['DNI 12345678Z factura 3 €', 'DNI [oculto] factura 3 €'],
    ['Tu código es 482913 pago 12,50 €', 'Tu código [oculto]'],
    ['user@example.com factura 3 €', '[oculto] factura 3 €'],
    ['https://banco.es/x?t=1 pago 5 €', '[oculto] pago 5 €'],
    ['Tarjeta **** 1234 pago 5 €', 'Tarjeta **** 1234 pago 5 €'],
  ];
  it.each(same)('redact(%j)', (input, out) => {
    expect(redact(input)).toBe(out);
  });

  it('las ventanas normales se siguen capturando', () => {
    for (const title of [
      'Documento - Word',
      'Factura luz.pdf - Adobe Acrobat',
      'Explorador de archivos',
    ]) {
      expect(isExcludedWindow({ title, process: 'x' })).toBe(false);
    }
  });

  it('un hallazgo normal sigue saliendo igual', () => {
    expect(
      findScreenFindings(['La factura vence el 15/11/2026: 45,00 €']).map((f) => f.snippet),
    ).toEqual(['La factura vence el 15/11/2026: 45,00 €']);
  });
});

describe('ojo pantalla — huecos cerrados', () => {
  it('oculta códigos de verificación en inglés (code, OTP, 2FA)', () => {
    expect(redact('Your verification code 482913 total 12,50 €')).not.toContain('482913');
    expect(redact('OTP 482913 importe 12,50 €')).not.toContain('482913');
    expect(redact('2FA: 482913 pago 5 €')).not.toContain('482913');
  });

  it('un código de verificación nunca llega a ser hallazgo', () => {
    expect(
      findScreenFindings(['Your code 482913 to confirm the payment of 12,50 € total']),
    ).toEqual([]);
  });

  it('oculta la fecha de nacimiento', () => {
    expect(redact('Fecha de nacimiento 01/02/1990 pago 5 €')).not.toContain('1990');
  });

  it('oculta URLs sin esquema («www.…»)', () => {
    expect(redact('www.banco.es/login?ref=abc pago 5 €')).toBe('[oculto] pago 5 €');
  });

  it('oculta la clave entera, sin dejar ver el prefijo', () => {
    const r = redact('sk-ABCDEFGHIJ1234567890 pago 5 €');
    expect(r).not.toContain('ABCDEFGHIJ');
    expect(r).toBe('[oculto] pago 5 €');
  });

  it.each([
    'Seguridad de Windows',
    'Windows Security',
    'Control de cuentas de usuario',
    'Tor Browser',
    'imagin - Tu banco',
    'MyInvestor',
    'Trade Republic',
    'Degiro',
    'Monzo',
    'Kraken',
    'Bit2Me',
    'Clave PIN - Agencia',
    'Mi Carpeta Ciudadana',
    'Muface',
  ])('no captura con «%s» abierta', (title) => {
    expect(isExcludedWindow({ title, process: 'x' })).toBe(true);
  });

  it('no captura con el diálogo de credenciales de Windows por proceso', () => {
    expect(isExcludedWindow({ title: '', process: 'CredentialUIBroker' })).toBe(true);
    expect(isExcludedWindow({ title: '', process: 'consent.exe' })).toBe(true);
    expect(isExcludedWindow({ title: '', process: 'tor.exe' })).toBe(true);
  });
});
