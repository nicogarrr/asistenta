import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «a cuánto está el volumen», «en qué canal está» o «qué app está abierta» iban al
// modelo; «a qué volumen está» y «qué canal tiene» ya miraban la tele.
describe('preguntas de estado de la tele', () => {
  it.each([
    'a cuánto está el volumen',
    'cuánto volumen tiene',
    '¿cuánto volumen hay?',
    'a cuánto tiene el volumen',
    'en qué canal está',
    'qué app está abierta',
    'qué aplicación está puesta',
  ])('«%s» mira la tele', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'status' });
  });

  it.each([
    'qué canal es mejor',
    // «¿qué canal es?» sigue yendo al modelo a propósito (test/tv-natural-hasta-canal-mas).
    '¿qué canal es?',
    'en qué canal echan el partido',
    'a cuánto está el euro',
    'cuánto cuesta netflix',
    'qué app es mejor para ver fútbol',
  ])('«%s» no es el estado de la tele', (text) => {
    expect(parseTvCommand(text)).not.toEqual({ action: 'status' });
  });
});
