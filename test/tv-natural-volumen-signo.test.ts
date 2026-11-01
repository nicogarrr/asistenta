import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «volumen +» se quedaba sin leer: la normalización quita el «+» (lo hace « plus »).
describe('«volumen +» / «volumen -» como el mando', () => {
  it.each([
    ['volumen +', 3],
    ['Volumen+', 3],
    ['vol +', 3],
    ['oye, volumen +', 3],
    ['volumen -', -3],
    ['vol −', -3],
    ['volumen +5', 5],
    ['volumen -5', -5],
    ['volumen – 2', -2],
  ])('«%s» -> %i', (t, steps) => {
    expect(parseTvCommand(t)).toEqual({ action: 'volumeStep', steps });
  });

  it('un número grande se recorta y se dice', () => {
    expect(parseTvCommand('volumen +20')).toEqual({
      action: 'volumeStep',
      steps: 15,
      requested: 20,
    });
  });

  it('«canal +» / «canal -» cambian de canal', () => {
    expect(parseTvCommand('canal +')).toEqual({ action: 'channel', channel: 'up' });
    expect(parseTvCommand('canal -')).toEqual({ action: 'channel', channel: 'down' });
  });

  it.each(['volumen', 'volumen +0', 'canal +2', 'volumen + y pon netflix'])(
    '«%s» no se adivina',
    (t) => {
      expect(parseTvCommand(t)).toBeNull();
    },
  );

  it('«pon disney+» sigue abriendo Disney+', () => {
    expect(parseTvCommand('pon disney+')).toEqual({ action: 'launch', appId: 'disney plus' });
  });
});
