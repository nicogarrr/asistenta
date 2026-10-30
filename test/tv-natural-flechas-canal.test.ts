import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

describe('tele: flechas, OK y salir del mando por voz', () => {
  it.each([
    ['ok', 'ENTER'],
    ['aceptar', 'ENTER'],
    ['pulsa ok', 'ENTER'],
    ['dale a ok', 'ENTER'],
    ['pulsa ok en la tele', 'ENTER'],
    ['pulsa el botón ok', 'ENTER'],
    ['arriba', 'UP'],
    ['abajo', 'DOWN'],
    ['izquierda', 'LEFT'],
    ['derecha', 'RIGHT'],
    ['a la derecha', 'RIGHT'],
    ['pulsa abajo', 'DOWN'],
    ['flecha arriba', 'UP'],
    ['dale a la flecha izquierda', 'LEFT'],
    ['muévete a la derecha', 'RIGHT'],
    ['salir', 'EXIT'],
    ['sal', 'EXIT'],
    ['sal de la app', 'EXIT'],
    ['pulsa salir', 'EXIT'],
  ])('«%s» → %s', (frase, name) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'key', name });
  });
  it.each([
    ['ENTER', 'pulsar OK'],
    ['UP', 'pulsar arriba'],
    ['DOWN', 'pulsar abajo'],
    ['LEFT', 'pulsar izquierda'],
    ['RIGHT', 'pulsar derecha'],
    ['EXIT', 'salir de la app'],
  ] as const)('%s se describe como «%s»', (name, desc) => {
    expect(describeTvIntent({ action: 'key', name })).toBe(desc);
  });
  it('«sube el volumen» no es la flecha arriba', () => {
    expect(parseTvCommand('sube el volumen')).toEqual({ action: 'volumeStep', steps: 3 });
  });
  it('«volumen arriba» sigue siendo volumen', () => {
    expect(parseTvCommand('volumen arriba')).toEqual({ action: 'volumeStep', steps: 3 });
  });
  it('«abajo y ok» va al modelo (orden combinada)', () => {
    expect(parseTvCommand('pulsa abajo y pulsa ok')).toBeNull();
  });
});

describe('tele: «cambia a la 2», «pon la tele en la 1», «cambia de canal»', () => {
  it.each([
    ['cambia a la 2', '2'],
    ['cambia a la dos', '2'],
    ['pon la tele en la 1', '1'],
    ['ponla en la 5', '5'],
    ['cámbiala a la 3', '3'],
  ])('«%s» → canal %s', (frase, channel) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'channel', channel });
  });
  it.each(['cambia de canal', 'cambia el canal'])('«%s» → canal siguiente', (frase) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'channel', channel: 'up' });
  });
});
