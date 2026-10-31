import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «sube el volumen de la tele a 20» o «sube la tele a 25» iban al modelo.
describe('volumen con «la tele» en medio', () => {
  it.each([
    ['sube el volumen de la tele a 20', { action: 'volume', level: 20 }],
    ['pon el volumen de la tele a 15', { action: 'volume', level: 15 }],
    ['baja el volumen de la tele a 10', { action: 'volume', level: 10 }],
    ['volumen de la tele a 30', { action: 'volume', level: 30 }],
    ['sube la tele a 25', { action: 'volume', level: 25 }],
    ['baja la tele a 10', { action: 'volume', level: 10 }],
    ['sube la tele a veinte', { action: 'volume', level: 20 }],
    ['sube el volumen de la tele 5', { action: 'volumeStep', steps: 5 }],
    ['sube la tele 5', { action: 'volumeStep', steps: 5 }],
  ])('«%s» va directo', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'el volumen de la tele está muy alto',
    'sube la tele de canal',
    'sube la tele a mi cuarto',
    'sube el volumen de la tele y apaga la luz',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
