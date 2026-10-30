import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: «súbele más», «dale a pausa», «stop», «pon el 5»', () => {
  it.each([
    ['súbele más', 3],
    ['sube más', 3],
    ['súbelo más', 3],
    ['sube más el volumen', 3],
    ['bájale más', -3],
    ['baja más', -3],
    ['bájala más', -3],
    ['baja más el volumen', -3],
  ] as const)('«%s» → paso de volumen', (text, steps) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volumeStep', steps });
  });

  it.each([
    'dale a pausa',
    'dale al pause',
    'pulsa pausa',
    'pause',
    'detén la peli',
    'detenla',
    'detén',
  ])('«%s» → pausa', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'pause' });
  });

  it.each(['pulsa play', 'dale a reproducir'])('«%s» → play', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'play' });
  });

  it.each(['stop', 'pulsa stop', 'dale al stop'])('«%s» → stop', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'stop' });
  });

  it.each([
    ['pon el 5', '5'],
    ['ponme el 24', '24'],
  ] as const)('«%s» → canal', (text, channel) => {
    expect(parseTvCommand(text)).toEqual({ action: 'channel', channel });
  });

  it.each(['un poco más', 'más', 'pon el 500', 'pon la peli'])(
    '«%s» sigue sin entenderse (va al modelo)',
    (text) => {
      expect(parseTvCommand(text)).toBeNull();
    },
  );
});
