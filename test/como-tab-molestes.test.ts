import { describe, expect, it } from 'vitest';
import { SAID_PREFIX, statedFact } from '../src/memory/owner-facts.js';
import { ownerQuietHours } from '../src/memory/owner-quiet.js';

/**
 * Como Tab: «no me molestes antes de las 9» y sus primas se apuntan igual que
 * «no me escribas…», y luego cuentan como horas de silencio.
 */
const saved = (text: string) => {
  const fact = statedFact(text);
  return fact === null ? null : `${SAID_PREFIX} ${fact}`;
};

describe('«no me molestes…» se apunta y se respeta', () => {
  it.each([
    ['no me molestes antes de las 9', 'No me molestes antes de las 9'],
    ['No me mandes nada antes de las 8', 'No me mandes nada antes de las 8'],
    ['no me envíes nada después de las 11', 'No me envíes nada después de las 11'],
    ['no me escribas antes de las 9 de la mañana', 'No me escribas antes de las 9 de la mañana'],
    [
      'no me molestes después de las 10 de la noche',
      'No me molestes después de las 10 de la noche',
    ],
  ])('«%s» se apunta', (text, fact) => {
    expect(statedFact(text)).toBe(fact);
  });

  it('lo apuntado mueve las horas de silencio', () => {
    expect(ownerQuietHours([saved('no me molestes antes de las 9') ?? ''])).toEqual({
      startHour: 22,
      endHour: 9,
    });
    expect(ownerQuietHours([saved('no me escribas antes de las 10 de la mañana') ?? ''])).toEqual({
      startHour: 22,
      endHour: 10,
    });
    expect(ownerQuietHours([saved('no me envíes nada después de las 11') ?? ''])).toEqual({
      startHour: 23,
      endHour: 8,
    });
  });

  it('lo pasajero sigue sin apuntarse', () => {
    expect(statedFact('no me molestes mañana')).toBeNull();
    expect(statedFact('no me molestes esta tarde')).toBeNull();
    expect(statedFact('mi vuelo es mañana a las 7')).toBeNull();
    expect(statedFact('no me molestes mañana antes de las 9 de la mañana')).toBeNull();
  });
});
