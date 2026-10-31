import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «pon la tele en el 5» no se entendía (solo «en la 5») e iba al modelo.
describe('canal con «el»: «pon la tele en el 5»', () => {
  it.each([
    ['pon la tele en el 5', '5'],
    ['ponla en el 5', '5'],
    ['ponlo en el 24', '24'],
    ['pon la tele en el cinco', '5'],
    ['oye, pon la tele en el 7, gracias', '7'],
  ])('«%s» pone el canal %s', (text, channel) => {
    expect(parseTvCommand(text)).toEqual({ action: 'channel', channel });
  });

  it('lo de siempre no cambia', () => {
    expect(parseTvCommand('pon la tele en la 5')).toEqual({ action: 'channel', channel: '5' });
    expect(parseTvCommand('pon la tele en el hdmi 2')).toEqual({ action: 'input', input: 'hdmi2' });
    expect(parseTvCommand('pon la tele en el salon')).toBeNull();
    expect(parseTvCommand('pon la tele en el 5 en un rato')).toBeNull();
    expect(parseTvCommand('pon la tele en el 5 y sube el volumen')).toBeNull();
  });
});
