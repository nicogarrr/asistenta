import { describe, expect, it } from 'vitest';
import { factKey, statedFact, supersededBy } from '../src/memory/owner-facts.js';

/**
 * agente-2: datos de lo más normales sobre Nico no se apuntaban al momento porque ninguna
 * forma los reconocía: lo que no come o no bebe, su estado civil, su equipo, su deporte.
 * Sin apuntar, el modelo los preguntaba («¿lo guardo?») o los olvidaba.
 */
describe('statedFact: comida, estado civil, equipo y deporte', () => {
  it.each([
    ['no como carne', 'No como carne'],
    ['no bebo alcohol', 'No bebo alcohol'],
    ['no tomo lactosa', 'No tomo lactosa'],
    ['no fumo', 'No fumo'],
    ['estoy casado con Ana', 'Estoy casado con Ana'],
    ['estoy divorciada', 'Estoy divorciada'],
    ['estoy soltero', 'Estoy soltero'],
    ['estoy jubilado', 'Estoy jubilado'],
    ['soy del Atleti', 'Soy del Atleti'],
    ['soy de la Real Sociedad', 'Soy de la Real Sociedad'],
    ['juego al pádel los martes', 'Juego al pádel los martes'],
    ['practico yoga', 'Practico yoga'],
  ])('«%s» se apunta', (text, saved) => {
    expect(statedFact(text)).toBe(saved);
  });

  it.each([
    'no como hoy',
    'no bebo esta noche',
    'estoy cansado',
    'estoy en el coche',
    'estoy casado con Ana, mándale un mensaje',
    'no fumo, ¿y tú?',
    'juego al pádel mañana',
  ])('«%s» no se apunta', (text) => {
    expect(statedFact(text)).toBeNull();
  });

  it('«estoy divorciado» deja viejo «estoy casado con Ana»', () => {
    expect(factKey('Estoy divorciado')).toBe(factKey('Estoy casado con Ana'));
    expect(supersededBy(['[dicho] Estoy casado con Ana'], 'Estoy divorciado')).toEqual([
      '[dicho] Estoy casado con Ana',
    ]);
  });

  it('«soy del Betis» sustituye a «soy del Atleti», pero no a «soy de Madrid»', () => {
    expect(
      supersededBy(['[dicho] Soy del Atleti', '[dicho] Soy de Madrid'], 'Soy del Betis'),
    ).toEqual(['[dicho] Soy del Atleti']);
  });
});
