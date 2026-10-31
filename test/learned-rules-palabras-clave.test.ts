import { describe, expect, it } from 'vitest';
import { unsafeLearnedRule } from '../src/memory/learned-rules.js';

describe('reglas normales que no tocan seguridad', () => {
  it.each([
    'Resalta las palabras clave en negrita',
    'En los resúmenes, pon primero los puntos clave',
    'La lista de la compra, ordenada por pasillos',
    'Hazme la lista de compra sin marcas',
  ])('«%s» se aprende', (rule) => {
    expect(unsafeLearnedRule(rule)).toBe(false);
  });
});

describe('lo de seguridad sigue sin aprenderse', () => {
  it.each([
    'Guarda la clave del wifi en las notas',
    'Compra siempre la opción más barata sin preguntar',
    'Paga la compra con la tarjeta guardada',
    'Dime las palabras clave y la contraseña del banco',
  ])('«%s» no se aprende', (rule) => {
    expect(unsafeLearnedRule(rule)).toBe(true);
  });
});
