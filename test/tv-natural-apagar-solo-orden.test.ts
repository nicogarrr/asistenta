import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «pausa que voy a apagar la tele» apagaba la tele: bastaba con que «apagar la tele»
// apareciera en cualquier parte de la frase. Ahora solo apaga si es la orden.
describe('apagar/encender solo cuando es la orden', () => {
  it.each([
    ['pausa que voy a apagar la tele', { action: 'media', command: 'pause' }],
    ['pausa que voy a encender la tele', { action: 'media', command: 'pause' }],
    ['baja el volumen que voy a apagar la tele', { action: 'volumeStep', steps: -3 }],
  ])('«%s» hace la orden de delante', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'voy a apagar la tele',
    'no voy a apagar la tele',
    'no apagar la tele',
    'sube el volumen antes de apagar la tele',
  ])('«%s» no apaga la tele', (text) => {
    expect(parseTvCommand(text)).not.toEqual({ action: 'power', on: false });
  });

  it.each([
    'apaga la tele',
    'apagar la tele',
    'apaga ya la tele',
    'hey, apaga la tele',
    'tengo sueño, apaga la tele',
    'apaga la tele, muchas gracias',
    'apaga la tele que me voy a dormir',
    'puedes apagar la tele',
    'me puedes apagar la tele',
    'quiero apagar la tele',
  ])('«%s» sigue apagando la tele', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'power', on: false });
  });

  it.each(['enciende la tele', 'oye enciende la tele', 'puedes encender la tele'])(
    '«%s» sigue encendiendo la tele',
    (text) => {
      expect(parseTvCommand(text)).toEqual({ action: 'power', on: true });
    },
  );
});
