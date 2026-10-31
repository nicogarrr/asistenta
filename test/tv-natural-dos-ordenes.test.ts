import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// Dos órdenes sin «y» hacían solo la mitad: «sube el volumen pon netflix» abría Netflix
// sin subir, y «abre netflix sube el volumen» buscaba la app «netflix sube el volumen».
describe('dos órdenes seguidas sin «y» van al modelo', () => {
  it.each([
    'sube el volumen pon netflix',
    'sube el volumen abre youtube',
    'abre netflix sube el volumen',
    'silencia abre netflix',
    'apaga el sonido pon netflix',
    'pon el canal 5 sube el volumen',
  ])('«%s»', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it.each([
    ['oye abre netflix', { action: 'launch', appId: 'netflix' }],
    ['pon la tele más baja', { action: 'volumeStep', steps: -3 }],
    ['ponle pausa a la peli', { action: 'media', command: 'pause' }],
    ['sube el volumen que no se oye', { action: 'volumeStep', steps: 3 }],
  ])('«%s» sigue siendo una orden', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });
});
