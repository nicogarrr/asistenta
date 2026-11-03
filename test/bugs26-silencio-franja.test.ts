import { describe, expect, it } from 'vitest';
import { SAID_PREFIX, statedFact } from '../src/memory/owner-facts.js';
import { ownerQuietHours, ownerStatedQuiet } from '../src/memory/owner-quiet.js';

/**
 * «no me escribas entre las 23 y las 8» se apuntaba («📝 Apuntado») pero las horas de
 * silencio no lo leían: solo entendían «antes de»/«después de», así que seguían las de
 * serie (22–8) y «desde las 23 hasta las 9» dejaba el final en las 8. Ahora la franja cuenta.
 */
const said = (text: string) => {
  const fact = statedFact(text);
  expect(fact, text).not.toBeNull();
  return ownerStatedQuiet([`${SAID_PREFIX} ${fact}`]);
};

describe('horas de silencio dichas como franja', () => {
  it.each([
    ['no me escribas entre las 23 y las 8', 23, 8],
    ['No me escribas de 23 a 8', 23, 8],
    ['no me escribas de 11 de la noche a 8 de la mañana', 23, 8],
    ['no me escribas desde las 23 hasta las 9', 23, 9],
    ['no me escribas de 10 a 7', 22, 7],
    ['no me mandes nada entre las once y las nueve', 23, 9],
    ['no me escribas entre la 1 y las 7', 1, 7],
    ['no me escribas entre las 22:30 y las 8 y media', 22, 9],
    ['no me escribas de 8 de la tarde a 12 de la noche', 20, 0],
  ])('%s → %i–%i', (text, startHour, endHour) => {
    expect(said(text)).toEqual({ startHour, endHour });
  });

  it('lo de antes sigue igual y una franja de más de 16 h se ignora', () => {
    expect(said('no me escribas antes de las 9')).toEqual({ startHour: 22, endHour: 9 });
    expect(said('no me escribas antes de las 9 ni después de las 11')).toEqual({
      startHour: 23,
      endHour: 9,
    });
    expect(said('no me escribas de 20 a 18')).toBeNull();
    expect(ownerQuietHours([`${SAID_PREFIX} No me escribas de 20 a 18`])).toEqual({
      startHour: 22,
      endHour: 8,
    });
  });
});
