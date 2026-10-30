import { describe, expect, it } from 'vitest';
import { telegramHtml } from '../src/channels/formatters.js';
import { chunkText } from '../src/channels/telegram.js';

/**
 * Un enlace markdown `[texto](url)` largo nunca se parte entre dos mensajes: si el
 * corte cae dentro del texto del enlace (que tiene espacios) o de su URL, el enlace
 * pasa entero al trozo siguiente. Partido, Telegram enseñaría «[texto» en un mensaje
 * y «resto](https://…)» en el otro, en vez de un enlace.
 */
const LINK = MD(
  'el informe completo de la reunión del consejo con todos los anexos',
  'https://example.com/docs/2026/informe-consejo?id=42&v=3',
);
function MD(label: string, url: string): string {
  return `[${label}](${url})`;
}
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()<>"]|\([^\s()<>"]*\))+)\)/g;

const links = (chunk: string) => chunk.match(LINK_RE) ?? [];

describe('chunkText no parte enlaces markdown', () => {
  it('el enlace de prueba cabe en todas las ventanas probadas', () => {
    expect(Array.from(LINK).length).toBeLessThan(140);
  });

  for (const size of [140, 160, 180, 200]) {
    for (const lead of [60, 80, 100]) {
      it(`ventana ${size}, enlace tras ${lead} caracteres: sale entero en un trozo`, () => {
        const text = `${'palabra '.repeat(lead / 8)}mira ${LINK} y luego sigue el texto normal hasta el final.`;
        const chunks = chunkText(text, size, { marks: true });
        expect(chunks.length).toBeGreaterThan(1);
        const whole = chunks.filter((c) => c.includes(LINK));
        expect(whole).toHaveLength(1);
        // Ningún trozo lleva un pedazo suelto del enlace.
        for (const c of chunks) {
          if (c.includes(LINK)) continue;
          expect(c).not.toContain('[el informe');
          expect(c).not.toContain('](https://');
        }
        for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(size);
      });
    }
  }

  it('en HTML cada trozo con el enlace lleva el <a href> completo', () => {
    const text = `${'texto de relleno '.repeat(6)}${LINK} fin.`;
    const htmls = chunkText(text, 150, { marks: true }).map((c) => telegramHtml(c));
    const withLink = htmls.filter((h) => h.includes('<a href='));
    expect(withLink).toHaveLength(1);
    expect(withLink[0]).toContain(
      'href="https://example.com/docs/2026/informe-consejo?id=42&amp;v=3"',
    );
    expect(htmls.join('\n')).not.toMatch(/\[el informe|\]\(https/);
  });

  it('un enlace más largo que la ventana se corta (no hay otra) sin bucle infinito', () => {
    const big = MD('x'.repeat(300), 'https://example.com/a');
    const chunks = chunkText(`hola ${big}`, 100, { marks: true });
    expect(chunks.join('').replace(/\s/g, '')).toContain('x'.repeat(50));
    for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(100);
  });

  it('texto sin enlaces corta igual que antes', () => {
    const text = `${'una frase corta. '.repeat(20)}`;
    expect(links(text)).toHaveLength(0);
    const chunks = chunkText(text, 100, { marks: true });
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.trim());
  });
});
