import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «enciende la tele y pon Netflix» encendía la tele y se olvidaba de
// Netflix sin decir nada. Dos órdenes encadenadas → null (las atiende el
// modelo, o se piden por separado), nunca media orden en silencio.
describe('natural.ts: dos órdenes encadenadas no se ejecutan a medias', () => {
  it.each([
    'enciende la tele y pon netflix',
    'enciende la tele y abre youtube',
    'apaga la tele y silencia',
    'silencia la tele y pon la 1',
    'sube el volumen y pon la 2',
    'pon netflix y sube el volumen',
    'pausa y baja el volumen',
  ])('«%s» → null', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it.each([
    ['modo cine con netflix', { action: 'scene', scene: 'cine', appId: 'netflix' }],
    ['apaga la tele', { action: 'power', on: false }],
    ['abre disney plus', { action: 'launch', appId: 'disney plus' }],
  ])('una sola orden sigue igual: «%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });
});

describe('natural.ts: frases de Nico que no se entendían', () => {
  it.each([
    ['volumen 20', { action: 'volume', level: 20 }],
    ['pon el volumen 15', { action: 'volume', level: 15 }],
    ['baja un poquito', { action: 'volumeStep', steps: -3 }],
    ['sube un poquito', { action: 'volumeStep', steps: 3 }],
    ['para la peli', { action: 'media', command: 'pause' }],
    ['reanuda la peli', { action: 'media', command: 'play' }],
    ['dale a play', { action: 'media', command: 'play' }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('«sube el volumen 5» sigue siendo relativo (no volumen a 5)', () => {
    expect(parseTvCommand('sube el volumen 5')).toEqual({ action: 'volumeStep', steps: 5 });
    expect(parseTvCommand('volumen 200')).toBeNull();
  });
});
