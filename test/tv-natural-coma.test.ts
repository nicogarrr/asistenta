import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// La coma se perdía antes de leer la frase, así que «sube el volumen, no se oye» iba
// al modelo. Ahora la coma separa la orden de su motivo, igual que «que».
describe('orden, motivo: «sube el volumen, no se oye»', () => {
  it.each([
    ['sube el volumen, no se oye', { action: 'volumeStep', steps: 3 }],
    ['baja el volumen, está muy alto', { action: 'volumeStep', steps: -3 }],
    ['pausa, voy al baño', { action: 'media', command: 'pause' }],
    ['pausa, ahora vuelvo', { action: 'media', command: 'pause' }],
    ['sube el volumen. no se oye', { action: 'volumeStep', steps: 3 }],
    ['sube el volumen!! no se oye', { action: 'volumeStep', steps: 3 }],
    ['no, sube el volumen', { action: 'volumeStep', steps: 3 }],
    ['sí, sube el volumen', { action: 'volumeStep', steps: 3 }],
    ['perdona, baja el volumen', { action: 'volumeStep', steps: -3 }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'pon la tele, empieza el partido',
    'pon netflix, y luego sube',
    'sube el volumen, ¿o está al máximo?',
    'apaga la tele, en 10 minutos',
    'sube el volumen, baja la luz',
    'la luz, apágala',
    'no, ¿por qué apagas?',
    'no sube el volumen',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
