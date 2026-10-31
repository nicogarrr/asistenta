import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// Escrito en el móvil, la orden suele acabar en punto: «pausa.» iba al modelo y
// «abre youtube.» buscaba una app llamada «youtube.».
describe('orden con punto final', () => {
  it.each([
    ['pausa.', { action: 'media', command: 'pause' }],
    ['dale al play.', { action: 'media', command: 'play' }],
    ['sube el volumen.', { action: 'volumeStep', steps: 3 }],
    ['vol 20.', { action: 'volume', level: 20 }],
    ['atrás.', { action: 'key', name: 'BACK' }],
    ['abajo.', { action: 'key', name: 'DOWN' }],
    ['ok.', { action: 'key', name: 'ENTER' }],
    ['pon la 1.', { action: 'channel', channel: '1' }],
    ['pausa..', { action: 'media', command: 'pause' }],
    ['silencio .', { action: 'mute', on: true }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('«abre youtube.» abre YouTube, no una app «youtube.»', () => {
    expect(parseTvCommand('abre youtube.')).toEqual(parseTvCommand('abre youtube'));
    expect(parseTvCommand('pon netflix.')).toEqual(parseTvCommand('pon netflix'));
  });

  it('el punto final no convierte en orden lo que no lo es', () => {
    expect(parseTvCommand('vale.')).toBeNull();
    expect(parseTvCommand('pausa en 10 minutos.')).toBeNull();
    expect(parseTvCommand('pon la tele que empieza el partido.')).toEqual(
      parseTvCommand('pon la tele que empieza el partido'),
    );
  });
});
