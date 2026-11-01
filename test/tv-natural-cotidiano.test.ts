import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// Frases de cada día que antes iban al modelo (y fallaban si el modelo no respondía).
describe('órdenes de tele del día a día, sin modelo', () => {
  it.each([
    ['pausa la tele', { action: 'media', command: 'pause' }],
    ['Pausa la tv por favor', { action: 'media', command: 'pause' }],
    ['reanuda la tele', { action: 'media', command: 'play' }],
    ['quita la pausa a la tele', { action: 'media', command: 'play' }],
    ['sube un canal', { action: 'channel', channel: 'up' }],
    ['baja un canal en la tele', { action: 'channel', channel: 'down' }],
    ['baja la tele', { action: 'volumeStep', steps: -3 }],
    ['sube un poco la tele', { action: 'volumeStep', steps: 3 }],
    ['baja el volumen ya', { action: 'volumeStep', steps: -3 }],
    ['sin sonido', { action: 'mute', on: true }],
    ['pon la tele sin sonido', { action: 'mute', on: true }],
    ['¿qué volumen tiene la tele?', { action: 'status' }],
    ['¿qué canal está puesto?', { action: 'status' }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(parseTvCommand('baja el volumen de la tele')).toEqual({
      action: 'volumeStep',
      steps: -3,
    });
    expect(parseTvCommand('sube el volumen a 20')).toEqual({ action: 'volume', level: 20 });
    expect(parseTvCommand('baja dos el volumen')).toEqual({ action: 'volumeStep', steps: -2 });
    expect(parseTvCommand('pausa')).toEqual({ action: 'media', command: 'pause' });
  });

  it('quejas y frases que no son órdenes siguen yendo al modelo', () => {
    expect(parseTvCommand('la tele está sin sonido')).toBeNull();
    expect(parseTvCommand('¿cómo se baja la tele?')).toBeNull();
    expect(parseTvCommand('baja la persiana')).toBeNull();
  });
});
