import { describe, expect, it } from 'vitest';
import { resolveSpecialist, specialistNames } from '../src/core/specialists.js';

/**
 * Nombres de especialista como los escribe el modelo (asis-expertos-3). «Smart TV»,
 * «home-assistant», «la tele» o «especialista de correo» caían en el subagente
 * genérico (sin las herramientas del especialista). Ahora se reconocen; lo que no
 * existe sigue cayendo en el genérico y nada raro resuelve a otra cosa.
 */
describe('resolveSpecialist: nombres con espacios, guiones y artículos', () => {
  it.each([
    ['Smart TV', 'tv'],
    ['smart-tv', 'tv'],
    ['la tele', 'tv'],
    ['Televisión', 'tv'],
    ['Home Assistant', 'hogar'],
    ['home_assistant', 'hogar'],
    ['especialista de correo', 'correo'],
    ['Especialista Tele', 'tv'],
    ['mi correo', 'correo'],
    ['correo electrónico', 'correo'],
    ['  Calendario  ', 'calendario'],
    ['las notas', 'notas'],
  ])('«%s» → %s', (name, canonical) => {
    expect(resolveSpecialist(name)?.name).toBe(canonical);
  });

  it('los nombres canónicos siguen igual', () => {
    for (const name of specialistNames()) expect(resolveSpecialist(name)?.name).toBe(name);
  });

  it.each([
    'especialista',
    'la',
    '',
    '   ',
    'tele tienda',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'pc pc',
    'banco',
  ])('«%s» no es un especialista (hijo genérico)', (name) => {
    expect(resolveSpecialist(name)).toBeUndefined();
  });
});
