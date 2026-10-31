import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «pausa la tele un rato»: la tele en medio de la frase también va directa a la
// tele, sin el modelo. Preguntas, quejas y «en un rato» siguen yendo al modelo.
describe('la tele en medio de la frase', () => {
  it.each([
    ['pausa la tele un rato', { action: 'media', command: 'pause' }],
    ['Pausa la tele un momento', { action: 'media', command: 'pause' }],
    ['para la tele un segundo', { action: 'media', command: 'pause' }],
    ['pausa la tele ahí', { action: 'media', command: 'pause' }],
    ['pon la tele en pausa', { action: 'media', command: 'pause' }],
    ['pon en pausa la tele', { action: 'media', command: 'pause' }],
    ['pon en pausa', { action: 'media', command: 'pause' }],
    ['quítale la pausa a la tele', { action: 'media', command: 'play' }],
    ['baja la tele un poco', { action: 'volumeStep', steps: -3 }],
    ['sube la tele un poco', { action: 'volumeStep', steps: 3 }],
    ['baja el volumen de la tele un poco', { action: 'volumeStep', steps: -3 }],
    ['apaga la tele un rato', { action: 'power', on: false }],
  ])('«%s» va directo', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'la tele está en pausa',
    'la tele está sin sonido un rato',
    '¿por qué se pausa la tele un momento?',
    '¿cómo pauso la tele un momento?',
    'pausa la tele en un rato',
    'pausa la tele un rato y apaga la luz',
    'deja la tele un rato',
    'mira la tele un rato',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
