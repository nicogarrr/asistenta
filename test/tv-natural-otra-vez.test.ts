import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «sube el volumen otra vez» o «vuelve a poner netflix» iban al modelo: repetir una
// orden es la misma orden.
describe('«otra vez» / «vuelve a …»', () => {
  it.each([
    ['sube el volumen otra vez', { action: 'volumeStep', steps: 3 }],
    ['sube el volumen de nuevo', { action: 'volumeStep', steps: 3 }],
    ['otra vez atrás', { action: 'key', name: 'BACK' }],
    ['pon otra vez netflix', { action: 'launch', appId: 'netflix' }],
    ['vuelve a subir el volumen', { action: 'volumeStep', steps: 3 }],
    ['vuelve a bajarlo', { action: 'volumeStep', steps: -3 }],
    ['vuelve a poner netflix', { action: 'launch', appId: 'netflix' }],
    ['vuelve a pausar', { action: 'media', command: 'pause' }],
    ['vuelve a encender la tele', { action: 'power', on: true }],
    ['vuelve a apagar la tele', { action: 'power', on: false }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it.each([
    'otra vez',
    'de nuevo',
    'otra vez no',
    'la tele se vuelve a apagar',
    'tele vuelve a apagarse sola',
    'vuelve a apagar la tele en 10 minutos',
    'vuelve a subir el volumen y pon netflix',
  ])('«%s» sigue yendo al modelo', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it('«vuelve» y «vuelve atrás» siguen siendo la tecla atrás', () => {
    expect(parseTvCommand('vuelve')).toEqual({ action: 'key', name: 'BACK' });
    expect(parseTvCommand('vuelve atrás')).toEqual({ action: 'key', name: 'BACK' });
  });
});
