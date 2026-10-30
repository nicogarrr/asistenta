import { describe, expect, it } from 'vitest';
import { redact } from '../src/ojo-screen.js';

/**
 * Un código pegado DELANTE de la palabra por un posesivo («tucódigo123»,
 * «sucontraseña: hunter2», «yourcode 4829») se quedaba a la vista: la regla de la
 * palabra exige un límite antes de «código». Solo oculta más.
 */
describe('ojo-screen: palabra de secreto con posesivo pegado delante', () => {
  it('oculta lo que sigue a tucódigo / sucontraseña / micontraseña / yourcode / mypassword', () => {
    for (const [line, secret] of [
      ['tucódigo123', '123'],
      ['Tucodigo 4829', '4829'],
      ['sucontraseña: hunter2', 'hunter2'],
      ['micontraseña es gato77', 'gato77'],
      ['yourcode 4829', '4829'],
      ['Mypassword=abc12', 'abc12'],
      ['tupin 0912', '0912'],
    ] as const) {
      const out = redact(line);
      expect(out, line).not.toContain(secret);
      expect(out, line).toContain('[oculto]');
    }
  });

  it('palabras normales que contienen «pin» o «code» no cambian', () => {
    for (const line of ['La pinza mide 2024 mm', 'Spin 360 grados', 'Encoder de 1080p a 30 fps']) {
      expect(redact(line)).toBe(line);
    }
  });
});
