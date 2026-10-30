import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: «apágala ya», «vuelve a poner el sonido», «¿qué hay en la tele?»', () => {
  it.each([
    ['apágala ya', false],
    ['venga, apágala ya', false],
    ['apágalo ya mismo', false],
    ['apaga ya', false],
    ['enciéndela ya', true],
    ['enciende la tele ahora', true],
  ] as const)('«%s» → encender/apagar', (text, on) => {
    expect(parseTvCommand(text)).toEqual({ action: 'power', on });
  });

  it.each(['vuelve a poner el sonido', 'vuelve a poner sonido', 'pon el sonido otra vez'])(
    '«%s» → quitar silencio',
    (text) => {
      expect(parseTvCommand(text)).toEqual({ action: 'mute', on: false });
    },
  );

  it.each([
    '¿qué hay en la tele?',
    '¿qué hay puesto en la tele?',
    '¿qué estoy viendo?',
    '¿qué estamos viendo en la tele?',
  ])('«%s» → estado (solo lee)', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'status' });
  });

  it.each(['la luz, apágala ya', '¿cómo se apaga ya?', 'apágala luego'])('«%s» → null', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
