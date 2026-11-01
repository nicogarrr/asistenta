import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

const SUBE = { action: 'volumeStep', steps: 3 };
const BAJA = { action: 'volumeStep', steps: -3 };

describe('tele: «modo juego» y «modo deportes» son modos de imagen', () => {
  it.each([
    ['modo juego', 'game'],
    ['pon el modo juego', 'game'],
    ['activa el modo videojuegos', 'game'],
    ['modo juego en la tele', 'game'],
    ['modo deportes', 'sports'],
    ['pon el modo fútbol', 'sports'],
  ])('«%s» → imagen %s', (frase, mode) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'picture', pictureMode: mode });
  });
  it('«modo cine» sigue siendo la rutina de cine', () => {
    expect(parseTvCommand('modo cine')).toEqual({ action: 'scene', scene: 'cine' });
  });
  it('«modo juego y pon Netflix» va al modelo (orden combinada)', () => {
    expect(parseTvCommand('modo juego y pon Netflix')).toBeNull();
  });
});

describe('tele: «oye…» y «tele, …» delante de la orden', () => {
  it.each([
    ['oye, sube el volumen', SUBE],
    ['oye sube el volumen', SUBE],
    ['tele, sube el volumen', SUBE],
    ['Oye tele, baja el volumen', BAJA],
    ['hey, apaga la tele', { action: 'power', on: false }],
    ['tele, pon Netflix', { action: 'launch', appId: 'netflix' }],
  ])('«%s»', (frase, intent) => {
    expect(parseTvCommand(frase)).toEqual(intent);
  });
  it('solo la muletilla no es una orden', () => {
    expect(parseTvCommand('oye')).toBeNull();
    expect(parseTvCommand('oye tele')).toBeNull();
  });
  it('la orden combinada con muletilla sigue yendo al modelo', () => {
    expect(parseTvCommand('oye, enciende la tele y pon Netflix')).toBeNull();
  });
});

describe('tele: «tres veces», «más baja», «volver»', () => {
  it.each([
    ['sube el volumen tres veces', { action: 'volumeStep', steps: 3 }],
    ['baja el volumen dos veces', { action: 'volumeStep', steps: -2 }],
    ['sube el volumen una vez', { action: 'volumeStep', steps: 1 }],
    ['baja 4 veces', { action: 'volumeStep', steps: -4 }],
    ['pon la tele más baja', BAJA],
    ['pon la tele más alta', SUBE],
    ['ponla más fuerte', SUBE],
    ['pon el volumen más bajito', BAJA],
    ['volver', { action: 'key', name: 'BACK' }],
    ['vuelve', { action: 'key', name: 'BACK' }],
    ['regresa', { action: 'key', name: 'BACK' }],
  ])('«%s»', (frase, intent) => {
    expect(parseTvCommand(frase)).toEqual(intent);
  });
  it('«sube el volumen veinte veces» se recorta y se dice', () => {
    expect(parseTvCommand('sube el volumen veinte veces')).toEqual({
      action: 'volumeStep',
      steps: 15,
      requested: 20,
    });
  });
});

describe('tele: «volumen al mínimo» es 1, nunca 0 ni silencio', () => {
  it.each([
    'volumen al mínimo',
    'baja el volumen al mínimo',
    'pon el volumen al mínimo',
    'bájalo al mínimo',
    'volumen a lo mínimo',
    'baja el volumen al mínimo de la tele',
  ])('«%s» → volumen 1', (frase) => {
    const i = parseTvCommand(frase);
    expect(i).toEqual({ action: 'volume', level: 1 });
    expect(describeTvIntent(i as NonNullable<typeof i>)).toBe('poner el volumen a 1');
  });
  it('«volumen a 0» sigue siendo 0 si se pide', () => {
    expect(parseTvCommand('volumen a 0')).toEqual({ action: 'volume', level: 0 });
  });
});
