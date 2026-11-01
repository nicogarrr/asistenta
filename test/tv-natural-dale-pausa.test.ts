import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// «dale pausa», «pon el pause», «dale el play» o «pulsa el botón de play» iban al
// modelo; «dale al play» y «pon pausa» ya iban directos.
describe('pausa y play con «el», «la» o «botón»', () => {
  it.each([
    'dale pausa',
    'dale la pausa',
    'pon el pause',
    'ponle el pause',
    'dale el pause',
    'pulsa el botón de pausa',
  ])('«%s» → pausa', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'pause' });
  });

  it.each([
    'dale el play',
    'pon el play',
    'ponle el play',
    'dale al botón de play',
    'pulsa el botón de play',
  ])('«%s» → play', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'media', command: 'play' });
  });

  it('dos órdenes siguen yendo al modelo', () => {
    expect(parseTvCommand('dale pausa y sube el volumen')).toBeNull();
    expect(parseTvCommand('dale el play en 5 minutos')).toBeNull();
  });
});
