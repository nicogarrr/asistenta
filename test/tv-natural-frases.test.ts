import { describe, expect, it } from 'vitest';
import { parseTvCommand, VOLUME_TOPE } from '../src/tv/natural.js';

describe('natural.ts: frases de Nico', () => {
  it.each([
    ['pon la uno', '1'],
    ['Pon la dos', '2'],
    ['ponme la cinco', '5'],
    ['canal siete', '7'],
    ['pon la 1', '1'],
  ])('«%s» → canal %s', (text, channel) => {
    expect(parseTvCommand(text)).toEqual({ action: 'channel', channel });
  });

  it.each([
    'sube a tope',
    'súbele a tope',
    'sube el volumen a tope',
    'volumen a tope',
    'volumen al máximo',
    'pon el volumen al máximo',
    'sube a tope la tele',
  ])('«%s» → volumen a 100 («a tope es a tope», decisión de Nico)', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volume', level: 100 });
    expect(VOLUME_TOPE).toBe(100);
  });

  it('un número explícito manda sobre el tope', () => {
    expect(parseTvCommand('volumen a 100')).toEqual({ action: 'volume', level: 100 });
  });

  it.each([
    ['pon la tele', null],
    ['pon la cena', null],
    ['quita el sonido', { action: 'mute', on: true }],
    ['apaga el sonido', { action: 'mute', on: true }],
    ['pon Disney', { action: 'launch', appId: 'disney' }],
  ])('«%s» sigue igual', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });
});
