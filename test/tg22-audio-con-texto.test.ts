/**
 * Un audio o nota de voz con texto («tradúcelo», «¿qué dice?») perdía ese texto: al
 * modelo solo le llegaba la transcripción y contestaba sin saber qué le pedías. Ahora el
 * texto va delante, como tus palabras; si el audio es reenviado, su texto va dentro de la
 * marca del reenvío, como lo demás de la otra persona.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { voiceNotePrompt } from '../src/cli.js';

const heard = { text: 'hola, llego tarde' };

describe('texto que acompaña a un audio', () => {
  it('tu texto llega al modelo delante de la transcripción', () => {
    expect(voiceNotePrompt(heard, undefined, 'tradúcelo al inglés')).toBe(
      'tradúcelo al inglés\n[Nota de voz transcrita] hola, llego tarde',
    );
  });

  it('sin texto, lo de siempre', () => {
    expect(voiceNotePrompt(heard)).toBe('[Nota de voz transcrita] hola, llego tarde');
    expect(voiceNotePrompt(heard, undefined, '  ')).toBe(
      '[Nota de voz transcrita] hola, llego tarde',
    );
  });

  it('el texto de un audio reenviado queda dentro de la marca del reenvío', () => {
    const fwd = '[Mensaje reenviado de Ana]';
    expect(voiceNotePrompt(heard, fwd, `${fwd}\nescucha esto`)).toBe(
      `${fwd}\nescucha esto\n[Nota de voz transcrita] hola, llego tarde`,
    );
    expect(voiceNotePrompt(heard, fwd, '')).toBe(
      `${fwd}\n[Nota de voz transcrita] hola, llego tarde`,
    );
  });

  it('el turno pasa el texto del mensaje', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain('voiceNotePrompt(heard, inbound.forwardedFrom, text)');
  });
});
