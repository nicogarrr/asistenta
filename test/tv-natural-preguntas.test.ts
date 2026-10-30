import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

// Preguntas y frases sobre otra cosa no son órdenes: van al modelo, la tele no se toca.
describe('parseTvCommand: preguntas y «apágala» de otra cosa', () => {
  it.each([
    '¿por qué se apaga la tele?',
    'por qué se apaga',
    '¿cómo se apaga la tele?',
    '¿cómo se enciende?',
    '¿se puede apagar la tele?',
    'la tele no se enciende',
    'no se enciende la tele',
    '¿sabes apagar la tele?',
    'la luz, apágala',
    'la lámpara, enciéndela',
    'el ventilador apágalo',
    '¿cómo se sube el volumen?',
    '¿por qué no pones Netflix?',
  ])('«%s» → null (no toca la tele)', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it.each([
    ['apágala', false],
    ['apágalo', false],
    ['oye tele, apágala', false],
    ['no, apágala', false],
    ['venga, apágala ya', null],
    ['apágame la tele', false],
    ['puedes apagar la tele', false],
    ['¿puedes apagar la tele?', false],
    ['apaga', false],
    ['apaga la tele', false],
    ['hey, apaga la tele', false],
    ['enciéndela', true],
    ['enciéndeme la tele', true],
    ['enciende el televisor', true],
    ['prende la tele', true],
  ] as const)('«%s» sigue igual', (text, on) => {
    const got = parseTvCommand(text);
    if (on === null) expect(got).toBeNull();
    else expect(got).toEqual({ action: 'power', on });
  });
});
