import { describe, expect, it } from 'vitest';
import { cleanForTelegram, dropEnglishMonologue } from '../src/channels/formatters.js';

describe('dropEnglishMonologue', () => {
  it('drops glued English reasoning before the Spanish answer', () => {
    const leaked =
      'I\'ll start by checking what I know about how to search Renfe trains.The skill says to use a "renfe" tool, but I don\'t have one. Let me go directly to the Renfe website with the browser.Ahora la fecha: sábado 10 de octubre de 2026.';
    expect(dropEnglishMonologue(leaked)).toBe('Ahora la fecha: sábado 10 de octubre de 2026.');
  });
  it('cuts a splice in the middle of a word', () => {
    const leaked =
      "Google bloqueó la búsqueda y no heGetting bogged down isn't the answer. I've been stuck in a loop of this and that without real progress.Google ha aceptado las cookies.";
    const out = dropEnglishMonologue(leaked);
    expect(out).not.toMatch(/bogged|stuck/);
    expect(out).toMatch(/Google ha aceptado las cookies\.$/);
  });
  it('leaves Spanish text, English-only replies and code alone', () => {
    const es = 'Amazon 235,54 € nuevo. MediaMarkt 285,00 €, envío gratis.';
    expect(dropEnglishMonologue(es)).toBe(es);
    const en = 'The price is 20 euros and the shipping is free for this item.';
    expect(dropEnglishMonologue(en)).toBe(en);
    const code = '```\nLet me go to the page and check this\n```\nHecho.';
    expect(dropEnglishMonologue(code)).toBe(code);
  });
  it('keeps legitimate English content (titles, out of stock)', () => {
    const real =
      'Resultado: The Pragmatic Programmer is out of stock in the store. Alternativa: 25,90 € en Casa del Libro.';
    expect(dropEnglishMonologue(real)).toBe(real);
    const title = 'Libro: The Lord of the Rings and the Return of the King. Precio: 12,50 €.';
    expect(dropEnglishMonologue(title)).toBe(title);
  });
  it('is applied by cleanForTelegram', () => {
    expect(
      cleanForTelegram(
        'Let me go directly to the Renfe website with the browser.Hay tren a las 9:00.',
      ),
    ).toBe('Hay tren a las 9:00.');
  });
});
