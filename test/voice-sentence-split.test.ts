import { describe, expect, it } from 'vitest';
import { splitPhrases, splitSentences } from '../src/voice/phrases.js';
import { splitSpeechChunks } from '../src/voice/tts.js';

const TEXT = 'La factura es de 1.500 euros y vence el 3.11. Mira tab.bot para más.';

describe('la voz no parte números, horas ni dominios por el punto', () => {
  it('splitSentences solo corta en punto seguido de espacio', () => {
    expect(splitSentences(TEXT)).toEqual([
      'La factura es de 1.500 euros y vence el 3.11.',
      'Mira tab.bot para más.',
    ]);
    expect(splitSentences('¿Vienes? ¡Claro! Vale… hasta luego')).toEqual([
      '¿Vienes?',
      '¡Claro!',
      'Vale…',
      'hasta luego',
    ]);
  });

  it('splitPhrases (voz por altavoz) no mete un punto y espacio dentro de «1.500»', () => {
    const joined = splitPhrases(TEXT).join(' ');
    expect(joined).toContain('1.500 euros');
    expect(joined).toContain('el 3.11.');
    expect(joined).toContain('tab.bot');
    expect(joined).not.toContain('1. 500');
  });

  it('splitSpeechChunks (nota de voz) tampoco parte «1.500», «10.30» ni «tab.bot»', () => {
    const chunks = splitSpeechChunks(
      'Quedamos a las 10.30 y son 1.500 euros. Lo tienes en tab.bot ahora.',
    );
    expect(chunks).toEqual([
      'Quedamos a las 10.30 y son 1.500 euros.',
      'Lo tienes en tab.bot ahora.',
    ]);
  });

  it('sigue cortando frases largas sin perder texto', () => {
    const long = `${'palabra '.repeat(80).trim()}. Fin.`;
    const chunks = splitSpeechChunks(long);
    expect(chunks.every((c) => c.length <= 240)).toBe(true);
    expect(chunks.join(' ')).toBe(long);
  });
});
