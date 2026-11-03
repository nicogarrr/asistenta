import { describe, expect, it } from 'vitest';
import { SAID_PREFIX, statedFact } from '../src/memory/owner-facts.js';
import { ownerStatedQuiet } from '../src/memory/owner-quiet.js';

/**
 * Horas de silencio dichas con las dos horas en la misma frase o de otra forma normal:
 * «no me escribas antes de las 9 ni después de las 11» perdía las 23:00 (seguía a las 22),
 * «… después de las 11 ni antes de las 9» perdía las 9, «ni antes de las 9 ni después de
 * las 23» no se leía entero, y «hasta las 9», «desde las 23» o «antes de las nueve» se
 * ignoraban.
 */
const q = (said: string) => ownerStatedQuiet([`${SAID_PREFIX} ${said}`]);

describe('horas de silencio: las dos horas y otras formas de decirlo', () => {
  it.each([
    ['no me escribas antes de las 9 ni después de las 11', 23, 9],
    ['no me escribas después de las 11 ni antes de las 9', 23, 9],
    ['no me escribas ni antes de las 9 ni después de las 23', 23, 9],
    ['no me mandes nada antes de las 7 y después de las 23', 23, 7],
    ['no me escribas antes de las 9, ni después de las 11 de la noche', 23, 9],
    ['no me escribas hasta las 9', 22, 9],
    ['no me escribas desde las 23', 23, 8],
    ['no me escribas antes de las nueve', 22, 9],
    ['no me escribas después de las once', 23, 8],
    ['no me escribas después de las 10 y media ni antes de las 9', 22, 9],
  ])('«%s» → %i–%i', (said, startHour, endHour) => {
    expect(q(said)).toEqual({ startHour, endHour });
  });

  it('lo que ya iba bien no cambia', () => {
    expect(q('no me escribas antes de las 9')).toEqual({ startHour: 22, endHour: 9 });
    expect(q('no me escribas antes de las 9 y media')).toEqual({ startHour: 22, endHour: 10 });
    expect(q('no me escribas después de las 12')).toEqual({ startHour: 0, endHour: 8 });
    expect(q('no me escribas después de la 1 de la madrugada')).toEqual({
      startHour: 1,
      endHour: 8,
    });
    expect(q('no me escribas antes de las 8:00')).toEqual({ startHour: 22, endHour: 8 });
    expect(q('estoy en el gimnasio hasta las 9')).toBeNull();
    expect(q('no me escribas mientras trabajo, que estoy hasta las 6')).toBeNull();
  });

  it('«antes de las 8:30» se apunta: los dos puntos de la hora no son otra frase', () => {
    expect(statedFact('no me escribas antes de las 8:30')).toBe('No me escribas antes de las 8:30');
    expect(statedFact('no me escribas después de las 22:30')).toBe(
      'No me escribas después de las 22:30',
    );
    expect(q('no me escribas antes de las 8:30')).toEqual({ startHour: 22, endHour: 9 });
    // Una segunda frase tras los dos puntos sigue sin apuntarse.
    expect(statedFact('no me escribas antes de las 9: estoy durmiendo')).toBeNull();
    expect(statedFact('no me escribas antes de las 9, ayúdame con el correo')).toBeNull();
  });
});
