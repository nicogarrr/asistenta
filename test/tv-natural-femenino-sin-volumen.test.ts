import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

const SUBE = { action: 'volumeStep', steps: 3 };
const BAJA = { action: 'volumeStep', steps: -3 };

describe('tele: «súbela», «bájala» (femenino) = un paso de volumen', () => {
  it.each([
    ['súbela', SUBE],
    ['bájala', BAJA],
    ['súbela un poco', SUBE],
    ['bájala un poquito', BAJA],
    ['bájala dos', { action: 'volumeStep', steps: -2 }],
  ])('«%s»', (frase, want) => {
    expect(parseTvCommand(frase)).toEqual(want);
  });
});

describe('tele: «más volumen», «volumen arriba» y parecidas', () => {
  it.each([
    ['más volumen', SUBE],
    ['un poco más de volumen', SUBE],
    ['volumen arriba', SUBE],
    ['volumen para arriba', SUBE],
    ['menos volumen', BAJA],
    ['volumen abajo', BAJA],
    ['volumen para abajo', BAJA],
  ])('«%s»', (frase, want) => {
    expect(parseTvCommand(frase)).toEqual(want);
  });
});

describe('tele: volumen a un número sin decir «volumen»', () => {
  it.each([
    ['sube a 30', 30],
    ['baja a 10', 10],
    ['bájala a diez', 10],
    ['pon la tele a 15', 15],
    ['ponla a 20', 20],
    ['déjala a 12', 12],
  ])('«%s» → volumen %i', (frase, level) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'volume', level });
  });
  it('«pon la 15» sigue siendo el canal 15', () => {
    expect(parseTvCommand('pon la 15')).not.toEqual({ action: 'volume', level: 15 });
  });
  it('«sube a 300» no es un volumen', () => {
    expect(parseTvCommand('sube a 300')).toBeNull();
  });
});

describe('tele: «apágala», «enciéndela», «el televisor»', () => {
  it.each([
    ['apágala', false],
    ['apágalo', false],
    ['apaga el televisor', false],
    ['enciéndela', true],
    ['enciende el televisor', true],
  ])('«%s»', (frase, on) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'power', on });
  });
  it('«sube el volumen de la televisión» = un paso', () => {
    expect(parseTvCommand('sube el volumen de la televisión')).toEqual(SUBE);
  });
});

describe('tele: «quítale el sonido» y «pon pausa»', () => {
  it('«quítale el sonido» silencia', () => {
    expect(parseTvCommand('quítale el sonido')).toEqual({ action: 'mute', on: true });
  });
  it('«quítale el silencio» sigue quitando el silencio', () => {
    expect(parseTvCommand('quítale el silencio')).toEqual({ action: 'mute', on: false });
  });
  it.each(['pon pausa', 'ponle pausa', 'pon la pausa'])('«%s» pausa', (frase) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'media', command: 'pause' });
  });
  it('«apágala y pon Netflix» va al modelo (orden combinada)', () => {
    expect(parseTvCommand('apágala y pon Netflix')).toBeNull();
  });
});
