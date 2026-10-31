import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «vol 2.5» ponía el volumen a 2: se perdía lo de detrás del punto o la coma.
describe('volumen con decimales', () => {
  it.each([
    ['vol 2.5', 3],
    ['volumen a 2,5', 3],
    ['pon el volumen a 12,5', 13],
    ['volumen a 12.4', 12],
    ['volumen al 0.5', 1],
    ['vol 99.9', 100],
  ])('«%s» → %i (redondeado)', (text, level) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volume', level });
  });

  it('los pasos también se redondean', () => {
    expect(parseTvCommand('sube 2.5')).toEqual({ action: 'volumeStep', steps: 3 });
    expect(parseTvCommand('baja 1,5')).toEqual({ action: 'volumeStep', steps: -2 });
  });

  it('un decimal fuera del volumen va al modelo', () => {
    expect(parseTvCommand('canal 2.5')).toBeNull();
    expect(parseTvCommand('pon la 2,5')).toBeNull();
    expect(parseTvCommand('apaga la tele a las 21.30')).toBeNull();
  });

  it('sin decimales nada cambia', () => {
    expect(parseTvCommand('vol 25')).toEqual({ action: 'volume', level: 25 });
    expect(parseTvCommand('canal 5')).toEqual({ action: 'channel', channel: '5' });
    expect(parseTvCommand('pausa. ahora vuelvo')).toEqual({ action: 'media', command: 'pause' });
  });
});
