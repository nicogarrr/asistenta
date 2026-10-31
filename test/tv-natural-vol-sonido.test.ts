import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «vol 20», «baja vol», «baja el sonido», «pon menos volumen» o «unmute» iban al
// modelo (y fallaban si el modelo no respondía). Son volumen o sonido de la tele.
describe('volumen dicho de otra forma', () => {
  it.each([
    ['vol 20', { action: 'volume', level: 20 }],
    ['vol a 20', { action: 'volume', level: 20 }],
    ['baja vol', { action: 'volumeStep', steps: -3 }],
    ['sube el vol', { action: 'volumeStep', steps: 3 }],
    ['baja el sonido', { action: 'volumeStep', steps: -3 }],
    ['subele el sonido', { action: 'volumeStep', steps: 3 }],
    ['baja el sonido a 10', { action: 'volume', level: 10 }],
    ['baja el sonido de la tele', { action: 'volumeStep', steps: -3 }],
    ['pon menos volumen', { action: 'volumeStep', steps: -3 }],
    ['dale mas volumen', { action: 'volumeStep', steps: 3 }],
    ['ponle un poco mas de volumen', { action: 'volumeStep', steps: 3 }],
    ['unmute', { action: 'mute', on: false }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('el silencio y lo demás no cambian', () => {
    expect(parseTvCommand('quita el sonido')).toEqual({ action: 'mute', on: true });
    expect(parseTvCommand('apaga el sonido')).toEqual({ action: 'mute', on: true });
    expect(parseTvCommand('pon el sonido')).toEqual({ action: 'mute', on: false });
    expect(parseTvCommand('vol +')).toEqual({ action: 'volumeStep', steps: 3 });
    expect(parseTvCommand('baja la voz')).toBeNull();
    expect(parseTvCommand('baja el sonido y apaga la tele')).toBeNull();
  });
});
