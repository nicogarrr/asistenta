import { describe, expect, it } from 'vitest';
import { SAID_PREFIX, statedFact } from '../src/memory/owner-facts.js';
import { ownerStatedQuiet } from '../src/memory/owner-quiet.js';

// bugs29: «Por favor, no me escribas antes de las 9», «no quiero que me escribas…», «nunca
// me escribas…» o «no me notifiques…» no se apuntaban; y «no me mandes notificaciones antes
// de las 9» se apuntaba («📝 Apuntado») pero las horas de silencio no lo leían.
const quiet = (said: string) => {
  const fact = statedFact(said);
  return fact ? ownerStatedQuiet([`${SAID_PREFIX}${fact}`]) : 'no se apuntó';
};

describe('horas de silencio dichas de otra forma (bugs29)', () => {
  it('se apuntan y cuentan como horas de silencio', () => {
    for (const said of [
      'Por favor, no me escribas antes de las 9',
      'por favor no me escribas antes de las 9',
      'no quiero que me escribas antes de las 9',
      'nunca me escribas antes de las 9',
      'no me notifiques antes de las 9',
      'no me mandes notificaciones antes de las 9',
    ]) {
      expect(quiet(said), said).toEqual({ startHour: 22, endHour: 9 });
    }
    expect(quiet('no me notifiques nada entre las 23 y las 8')).toEqual({
      startHour: 23,
      endHour: 8,
    });
    expect(quiet('nunca me escribas después de las 23')).toEqual({ startHour: 23, endHour: 8 });
  });

  it('lo de siempre sigue igual, y lo que no es un dato no se apunta', () => {
    expect(quiet('no me escribas antes de las 9')).toEqual({ startHour: 22, endHour: 9 });
    expect(quiet('no me escribas antes de las 9, por favor')).toEqual({
      startHour: 22,
      endHour: 9,
    });
    // Una pregunta o algo pasajero no es un dato.
    expect(statedFact('¿no me escribas antes de las 9?')).toBeNull();
    expect(statedFact('hoy no me escribas antes de las 9')).toBeNull();
  });
});
