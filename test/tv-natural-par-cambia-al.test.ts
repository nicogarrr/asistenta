import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: «súbele un par», «cambia al 7», «apaga ya la tele»', () => {
  it.each([
    ['súbele un par', 2],
    ['sube un par de puntos', 2],
    ['bájale un par', -2],
    ['baja un par de puntos', -2],
    ['baja el volumen un par de puntos', -2],
    ['sube dos puntitos', 2],
    ['baja tres puntitos', -3],
  ] as const)('«%s» → paso de %i', (text, steps) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volumeStep', steps });
  });

  it.each([
    ['cambia al 7', '7'],
    ['cámbiala al 24', '24'],
    ['cambia la tele al 3', '3'],
  ] as const)('«%s» → canal %s', (text, channel) => {
    expect(parseTvCommand(text)).toEqual({ action: 'channel', channel });
  });

  it.each(['apaga ya la tele', 'apaga ya el televisor'])('«%s» → apagar', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'power', on: false });
  });
  it('«enciende ya la tele» → encender', () => {
    expect(parseTvCommand('enciende ya la tele')).toEqual({ action: 'power', on: true });
  });

  it.each([
    'sube un par de minutos',
    'baja en un par de minutos',
    'cambia al otro',
    'cambia al 7 y sube el volumen',
    '¿por qué se apaga ya la tele?',
    'la luz, apaga ya la tele',
  ])('«%s» → al modelo (null)', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
