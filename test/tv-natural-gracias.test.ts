import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «pausa, gracias» o «asistenta, pausa la tele» iban al modelo: el «gracias» del
// final y el nombre delante no cambian la orden.
describe('gracias y «asistenta» alrededor de la orden', () => {
  it.each([
    ['pausa, gracias', { action: 'media', command: 'pause' }],
    ['sube el volumen, gracias', { action: 'volumeStep', steps: 3 }],
    ['apaga la tele, muchas gracias', { action: 'power', on: false }],
    ['asistenta, pausa la tele', { action: 'media', command: 'pause' }],
    ['oye asistenta, sube el volumen', { action: 'volumeStep', steps: 3 }],
    ['Asistenta, pon el canal 5, gracias', { action: 'channel', channel: '5' }],
  ])('«%s» va directo', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'gracias',
    'muchas gracias',
    'asistenta',
    'asistenta, ¿cómo se apaga la tele?',
    'oye asistenta, la tele no se enciende',
  ])('«%s» no es una orden', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
