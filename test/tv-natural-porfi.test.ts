import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// Solo «porfa» y «por favor» se quitaban: «apágala porfi», «sube el volumen x favor»
// o «baja el volumen plis» iban al modelo. La cortesía no cambia la orden.
describe('«porfi», «x favor», «xfa», «plis»', () => {
  it.each([
    ['apagala porfi', { action: 'power', on: false }],
    ['sube el volumen x favor', { action: 'volumeStep', steps: 3 }],
    ['pausa xfa', { action: 'media', command: 'pause' }],
    ['baja el volumen plis', { action: 'volumeStep', steps: -3 }],
    ['pon la 5 porfis', { action: 'channel', channel: '5' }],
    ['abre netflix porfi', { action: 'launch', appId: 'netflix' }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('sin orden no hay nada que hacer', () => {
    expect(parseTvCommand('porfi')).toBeNull();
    expect(parseTvCommand('xavier')).toBeNull();
    expect(parseTvCommand('pausa porfa')).toEqual({ action: 'media', command: 'pause' });
  });
});
