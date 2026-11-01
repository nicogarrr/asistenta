import { describe, expect, it } from 'vitest';
import { COMPUTER_SWITCH_USAGE, computerSwitchCommand } from '../src/screen/computer-switch.js';

/** /ordenador acepta palabras naturales sin importar tildes, mayúsculas ni puntuación. */
function deps(start: boolean) {
  const state = { on: start, sets: [] as boolean[] };
  return {
    state,
    d: {
      isOwner: true,
      enabled: () => state.on,
      set: (v: boolean) => {
        state.on = v;
        state.sets.push(v);
      },
    },
  };
}

describe('/ordenador · palabras tolerantes', () => {
  it.each([
    'off.',
    'apagado',
    'apágalo',
    'Apágalo!',
    'OFF!',
    '  apagado. ',
    'desactívalo',
    '¡apaga!',
  ])('«%s» apaga', (word) => {
    const { state, d } = deps(true);
    expect(computerSwitchCommand(word, d)).toMatch(/desactivado/);
    expect(state.sets).toEqual([false]);
  });

  it.each(['on.', 'encendido', 'actívalo', 'ACTÍVALO.', 'enciéndelo', '¿on?', 'Sí.'])(
    '«%s» enciende',
    (word) => {
      const { state, d } = deps(false);
      expect(computerSwitchCommand(word, d)).toMatch(/activado/);
      expect(state.sets).toEqual([true]);
    },
  );

  it.each(['Estado.', 'estado?'])('«%s» solo dice el estado', (word) => {
    const { state, d } = deps(true);
    expect(computerSwitchCommand(word, d)).toMatch(/ACTIVADO/);
    expect(state.sets).toEqual([]);
  });

  it.each(['banana', 'apagado ya', 'off on', '...', 'o.f.f', 'offf'])(
    '«%s» desconocida: ayuda y no toca nada',
    (word) => {
      const { state, d } = deps(true);
      expect(computerSwitchCommand(word, d)).toBe(COMPUTER_SWITCH_USAGE);
      expect(state.sets).toEqual([]);
    },
  );

  it('quien no es el dueño sigue sin poder, aunque escriba bien', () => {
    const { state, d } = deps(true);
    expect(computerSwitchCommand('apágalo', { ...d, isOwner: false })).toMatch(/Solo el dueño/);
    expect(state.sets).toEqual([]);
  });
});
