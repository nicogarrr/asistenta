import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «play a la peli», «dale al play a la serie», «ponle pausa a la peli» iban al
// modelo. Lo que se pausa o reanuda no cambia la tecla: van directas a la tele.
describe('play y pausa con «a la peli»', () => {
  it.each([
    ['play a la peli', 'play'],
    ['dale al play a la peli', 'play'],
    ['dale al play a la serie', 'play'],
    ['quita la pausa a la peli', 'play'],
    ['sigue la peli', 'play'],
    ['ponle pausa a la peli', 'pause'],
    ['pausa a la peli', 'pause'],
    ['dale al pause a la serie', 'pause'],
    ['pon en pausa la peli', 'pause'],
    ['dale a la pausa', 'pause'],
    ['dale al stop a la peli', 'stop'],
  ])('«%s» → %s', (text, command) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command });
  });

  it('lo demás sigue igual', () => {
    expect(parseTvCommand('dale al play')).toEqual({ action: 'media', command: 'play' });
    expect(parseTvCommand('para la peli')).toEqual({ action: 'media', command: 'pause' });
    expect(parseTvCommand('dale a la peli')).toBeNull();
    expect(parseTvCommand('pon la peli')).toBeNull();
    expect(parseTvCommand('play a la peli en un rato')).toBeNull();
    expect(parseTvCommand('play a la peli y sube el volumen')).toBeNull();
    expect(parseTvCommand('por que no va el play de la peli')).toBeNull();
  });
});
