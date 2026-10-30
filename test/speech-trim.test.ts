import { describe, expect, it } from 'vitest';
import { trimForSpeech } from '../src/cli.js';

describe('trimForSpeech: lo que se dice en voz alta', () => {
  it('no lee emojis ni viñetas, y una lista hace pausas entre elementos', () => {
    const out = trimForSpeech('Hecho ✅ 👍\nLista de la compra:\n- Leche\n- Huevos\n• Pan');
    expect(out).toBe('Hecho. Lista de la compra: Leche. Huevos. Pan');
  });

  it('una respuesta larga se corta en un fin de frase, nunca a media palabra', () => {
    const sentence = 'Mañana a las nueve tienes la reunión con el equipo de ventas en la oficina. ';
    const out = trimForSpeech(sentence.repeat(20));
    expect(out.length).toBeLessThanOrEqual(903);
    expect(out.endsWith('oficina....')).toBe(true);
    expect(out).not.toMatch(/\s\S{1,3}\.\.\.$/);
  });

  it('sin frases, corta en una palabra', () => {
    const out = trimForSpeech('palabra '.repeat(200));
    expect(out.endsWith('palabra...')).toBe(true);
  });
});
