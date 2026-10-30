import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: «volumen más», «desmutea», «para el vídeo», «ve a youtube»', () => {
  it.each([
    ['volumen más', 3],
    ['volumen menos', -3],
  ] as const)('«%s» → paso de %i', (text, steps) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volumeStep', steps });
  });

  it.each([
    ['volumen máximo', 100],
    ['pon el volumen máximo', 100],
    ['volumen mínimo', 1],
  ] as const)('«%s» → volumen %i', (text, level) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volume', level });
  });

  it.each(['desmutea', 'desmutea la tele', 'enciende el sonido'])(
    '«%s» → quitar silencio',
    (text) => {
      expect(parseTvCommand(text)).toEqual({ action: 'mute', on: false });
    },
  );

  it.each(['para el vídeo', 'pausa el video', 'detén el vídeo'])('«%s» → pausa', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'pause' });
  });
  it.each(['continúa el vídeo', 'reanuda el vídeo', 'sigue con el video'])(
    '«%s» → play',
    (text) => {
      expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'play' });
    },
  );

  it.each([
    ['pásate al 7', '7'],
    ['pasa al 12', '12'],
  ] as const)('«%s» → canal %s', (text, channel) => {
    expect(parseTvCommand(text)).toEqual({ action: 'channel', channel });
  });

  it.each(['intro', 'pulsa intro'])('«%s» → tecla OK', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'key', name: 'ENTER' });
  });

  it.each([
    ['ve a youtube', 'youtube'],
    ['vete a netflix', 'netflix'],
  ] as const)('«%s» → abrir %s', (text, appId) => {
    expect(parseTvCommand(text)).toEqual({ action: 'launch', appId });
  });

  it.each([
    've a dormir',
    've a la cama',
    've a casa',
    'pasa al siguiente',
    'volumen bajo',
    'siguiente',
    'acepta',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it('sin cambios: «ve a inicio», «apaga el sonido», «para la peli»', () => {
    expect(parseTvCommand('ve a inicio')).toEqual({ action: 'key', name: 'HOME' });
    expect(parseTvCommand('apaga el sonido')).toEqual({ action: 'mute', on: true });
    expect(parseTvCommand('para la peli')).toEqual({ action: 'media', command: 'pause' });
  });
});
