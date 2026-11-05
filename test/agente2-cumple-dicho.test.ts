import { describe, expect, it } from 'vitest';
import { factKey, statedFact, supersededBy } from '../src/memory/owner-facts.js';

/**
 * agente-2: «el cumple de mi madre es el 6 de noviembre» o «Javi cumple años el 20 de
 * noviembre» no se apuntaban al momento (ninguna forma empezaba así), así que el resumen de
 * la mañana nunca podía recordarlos.
 */
describe('statedFact: cumpleaños y aniversarios', () => {
  it.each([
    ['el cumple de mi madre es el 6 de noviembre', 'El cumple de mi madre es el 6 de noviembre'],
    ['el cumpleaños de Javi es el 14/2', 'El cumpleaños de Javi es el 14/2'],
    ['mi madre cumple años el 6 de noviembre', 'Mi madre cumple años el 6 de noviembre'],
    ['Javi cumple el 20 de noviembre', 'Javi cumple el 20 de noviembre'],
    ['el santo de mi padre es el 19 de marzo', 'El santo de mi padre es el 19 de marzo'],
    ['nuestro aniversario es el 8 de junio', 'Nuestro aniversario es el 8 de junio'],
  ])('«%s» se apunta', (text, saved) => {
    expect(statedFact(text)).toBe(saved);
  });

  it.each([
    'el cumple de mi madre es mañana',
    '¿cuándo es el cumple de mi madre?',
    'el cumple de mi madre es el 6, recuérdamelo el día antes',
    'Javi cumple 40 este año',
  ])('«%s» no se apunta', (text) => {
    expect(statedFact(text)).toBeNull();
  });

  it('las dos formas del mismo cumple se sustituyen', () => {
    expect(factKey('Mi madre cumple años el 7 de noviembre')).toBe(
      factKey('El cumple de mi madre es el 6 de noviembre'),
    );
    expect(
      supersededBy(
        ['[dicho] El cumple de mi madre es el 6 de noviembre'],
        'Mi madre cumple el 7 de noviembre',
      ),
    ).toEqual(['[dicho] El cumple de mi madre es el 6 de noviembre']);
    expect(factKey('El cumple de Javi es el 1 de mayo')).not.toBe(
      factKey('El cumple de mi madre es el 6 de noviembre'),
    );
  });
});
