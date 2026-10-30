import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: órdenes combinadas con modos u otros aparatos van al modelo', () => {
  it.each([
    'cambia al modo cine y sube',
    'modo cine y sube el volumen',
    'pon el modo cine y apaga la luz',
    'modo noche y baja el volumen',
    'pon el modo juego y abre youtube',
    'pon la imagen en estándar y sube',
    'vuelve atrás y pulsa ok',
    'apaga la tele y la luz',
    'apaga la tele y también las luces',
    'enciende la tele y el altavoz',
    'apágala y la radio también',
  ])('«%s» → al modelo (null)', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it.each([
    ['modo cine', { action: 'scene', scene: 'cine' }],
    ['pon el modo cine con netflix', { action: 'scene', scene: 'cine', appId: 'netflix' }],
    ['modo noche', { action: 'scene', scene: 'noche' }],
    ['apaga todo', { action: 'scene', scene: 'apagar-todo' }],
    ['apaga la tele', { action: 'power', on: false }],
    ['enciende la tele', { action: 'power', on: true }],
    ['vuelve atrás', { action: 'key', name: 'BACK' }],
  ] as const)('sin cambios: «%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });
});
