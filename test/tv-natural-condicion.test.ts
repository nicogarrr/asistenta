import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «si me duermo, apaga la tele» apagaba la tele al momento: el «si…» es una
// condición, no una orden para ahora. Ahora va al modelo y no se ejecuta nada.
describe('una condición («si…», «en cuanto…») no se ejecuta ya', () => {
  it.each([
    'si me duermo, apaga la tele',
    'si me duermo apaga la tele',
    'si me quedo dormido apaga la tele',
    'pues si me duermo, apaga la tele',
    'y si me duermo apaga la tele',
    'si me acuesto, apaga la tele',
    'si eso apaga la tele',
    'si te digo apaga la tele',
    'apaga la tele si me duermo',
    'en cuanto me duerma apaga la tele',
    'por si acaso apaga la tele',
    'si me duermo, enciende la tele',
    'si llega Ana pon netflix',
    'si no se oye, sube el volumen',
  ])('«%s» no hace nada ahora', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it.each([
    ['sí, apaga la tele', { action: 'power', on: false }],
    ['si, apaga la tele', { action: 'power', on: false }],
    ['sí sí, apaga la tele', { action: 'power', on: false }],
    ['vale sí, apágala', { action: 'power', on: false }],
    ['sí, pon netflix', { action: 'launch', appId: 'netflix' }],
    ['apaga la tele', { action: 'power', on: false }],
    ['pon netflix, sí', { action: 'launch', appId: 'netflix' }],
  ])('«%s» sigue siendo la orden', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });
});
