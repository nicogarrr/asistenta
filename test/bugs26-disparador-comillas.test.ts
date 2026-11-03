import { describe, expect, it } from 'vitest';
import { mailMatches, parseMailMatch } from '../src/triggers.js';

/**
 * /disparador correo escrito en el móvil: el teclado pone comillas tipográficas
 * («asunto:“billete de tren”») y a menudo un espacio tras los dos puntos («de: renfe»).
 * Antes la frase se partía en palabras con la comilla pegada («“billete», «tren”») y «de:»
 * quedaba como texto que buscar: el disparador no saltaba nunca, sin avisar.
 */
const RENFE = { from: 'Renfe <billetes@renfe.com>', subject: 'Tu billete de tren Madrid-Valencia' };

describe('disparador de correo: comillas del móvil y «de: x»', () => {
  it.each([
    'de:renfe asunto:“billete de tren”',
    'asunto:«billete de tren»',
    'de: renfe',
    'de: renfe asunto: billete',
  ])('«%s» salta con el correo de Renfe', (match) => {
    expect(mailMatches(match, RENFE)).toBe(true);
  });

  it('lee la frase entera entre comillas tipográficas', () => {
    expect(parseMailMatch('de:renfe asunto:“billete de tren”')).toEqual({
      from: ['renfe'],
      subject: ['billete de tren'],
      any: [],
    });
    expect(parseMailMatch('de: renfe')).toEqual({ from: ['renfe'], subject: [], any: [] });
  });

  it('lo de antes no cambia', () => {
    expect(parseMailMatch('de:renfe asunto:"billete de tren" urgente')).toEqual({
      from: ['renfe'],
      subject: ['billete de tren'],
      any: ['urgente'],
    });
    expect(mailMatches('de:iberia', RENFE)).toBe(false);
    expect(mailMatches('billete de tren', RENFE)).toBe(true);
  });
});
