import { describe, expect, it } from 'vitest';
import { forgetRequest } from '../src/memory/owner-facts.js';

/**
 * Tras «mi dentista es el Dr. García», decir «eso ya no es así» iba al modelo, que no borra
 * del perfil. Ahora se olvida lo recién apuntado (si no hay nada reciente, sigue el modelo).
 */
describe('«eso ya no es así» olvida lo recién apuntado', () => {
  it.each([
    'eso ya no es así',
    'Eso ya no es asi.',
    'ya no es verdad',
    'no, eso ya no es cierto',
    'eso ha cambiado',
    'me equivoqué, bórralo'.replace('bórralo', 'borralo'),
    'me equivoque, olvida eso',
  ])('%s', (said) => {
    expect(forgetRequest(said)).toEqual({ kind: 'last' });
  });

  it('frases parecidas que no son eso siguen igual', () => {
    expect(forgetRequest('ya no es así como se hace la tortilla')).toBeNull();
    expect(forgetRequest('eso no es así')).toBeNull();
    expect(forgetRequest('eso ya no')).toBeNull();
    expect(forgetRequest('ya no tengo coche')).toEqual({ kind: 'match', query: 'coche' });
  });
});
