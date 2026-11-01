import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: «sube hasta 30», «canal más», «pausa el partido», «modo gaming»', () => {
  it.each([
    ['sube el volumen hasta 30', 30],
    ['volumen hasta 30', 30],
    ['sube hasta 30', 30],
    ['baja hasta 10', 10],
    ['baja el volumen hasta el 10', 10],
  ] as const)('«%s» → volumen %i', (text, level) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volume', level });
  });

  it.each([
    ['canal más', 'up'],
    ['canal menos', 'down'],
    ['sintoniza el 5', '5'],
    ['sintoniza la 1', '1'],
  ] as const)('«%s» → canal %s', (text, channel) => {
    expect(parseTvCommand(text)).toEqual({ action: 'channel', channel });
  });

  it.each(['para la música', 'pausa el capítulo', 'pausa el episodio', 'pausa el partido'])(
    '«%s» → pausa',
    (text) => {
      expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'pause' });
    },
  );
  it.each([
    'pon play',
    'dale play',
    'sigue reproduciendo',
    'continúa reproduciendo',
    'sigue con el partido',
  ])('«%s» → play', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'play' });
  });
  it('«adelanta el capítulo» → avance', () => {
    expect(parseTvCommand('adelanta el capítulo')).toEqual({
      action: 'media',
      command: 'fastForward',
    });
  });

  it.each(['modo gaming', 'pon el modo gaming'])('«%s» → imagen juego', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'picture', pictureMode: 'game' });
  });

  it.each([
    'reproduce',
    'reprodúcelo en la tele',
    'sube hasta el final',
    'sube el volumen hasta que se oiga',
    'espera hasta 10',
    'modo juego y sube el volumen',
    '¿qué canal es?',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
