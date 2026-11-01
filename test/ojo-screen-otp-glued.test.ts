import { describe, expect, it } from 'vitest';
import { redact } from '../src/ojo-screen.js';

/**
 * El vigilante de pantalla oculta códigos y PIN antes de guardar o enviar nada.
 * Se escapaban:
 * - códigos pegados a la palabra («PIN1234», «código482913», «OTP77310»): la
 *   regla de la palabra clave pedía un límite de palabra justo detrás, y entre
 *   «N» y «1» no lo hay; los 4–8 dígitos no llegan a las reglas de números largos.
 * - frases sin ninguna palabra de la lista («482913 es tu clave de un solo uso»
 *   sí, pero «Usa 482913, válido para un solo uso», «Your one-time 4829»,
 *   «Autenticación en dos pasos: 731942» no).
 * Solo se oculta más: nada que antes se ocultaba deja de ocultarse.
 */
describe('vigilante de pantalla: códigos pegados y más frases', () => {
  it('código pegado a la palabra', () => {
    for (const [line, code] of [
      ['Tu PIN1234 para la tarjeta', '1234'],
      ['código482913', '482913'],
      ['OTP77310 caduca en 5 min', '77310'],
      ['Contraseña2468 temporal', '2468'],
      ['Code123456', '123456'],
    ] as const) {
      expect(redact(line), line).not.toContain(code);
    }
  });

  it('frases de un solo uso / one-time / dos pasos', () => {
    for (const [line, code] of [
      ['Usa 482913, válido para un solo uso', '482913'],
      ['Your one-time 4829 expires soon', '4829'],
      ['Enter 556677 (one time only)', '556677'],
      ['Autenticación en dos pasos: 731942', '731942'],
      ['Two-factor: 991122', '991122'],
      ['Single-use 8080 for checkout', '8080'],
    ] as const) {
      expect(redact(line), line).not.toContain(code);
    }
  });

  it('lo que ya se ocultaba sigue oculto y el texto normal no cambia', () => {
    expect(redact('PIN: 1234')).toBe('PIN [oculto]');
    expect(redact('código 482913')).toBe('código [oculto]');
    expect(redact('482913 es tu contraseña de un solo uso')).not.toContain('482913');
    // Palabras que solo empiezan como una clave no disparan la regla.
    expect(redact('La pinza mide 2024 mm')).toBe('La pinza mide 2024 mm');
    expect(redact('Reunión a las 1730 en la sala 4')).toBe('Reunión a las 1730 en la sala 4');
    expect(redact('Codes of conduct 2024')).toBe('Codes of conduct 2024');
  });
});
