import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/channels/telegram.js';

const para = (n: number, word: string) => Array.from({ length: n }, () => word).join(' ');

describe('chunkText corta en fronteras naturales', () => {
  it('parte entre párrafos, no a mitad de palabra', () => {
    const a = `${para(60, 'recordatorio')}.`;
    const b = `${para(60, 'calendario')}.`;
    const parts = chunkText(`${a}\n\n${b}`, 1000);
    expect(parts).toEqual([a, b]);
  });

  it('sin párrafos, corta en un final de frase', () => {
    const s1 = `${para(40, 'uno')}.`;
    const s2 = `${para(40, 'dos')}.`;
    const parts = chunkText(`${s1} ${s2}`, 200);
    expect(parts[0]?.endsWith('.')).toBe(true);
    for (const p of parts) expect(Array.from(p).length).toBeLessThanOrEqual(200);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(`${s1} ${s2}`);
  });

  it('una sola frase larga se corta en un espacio, nunca dentro de una palabra', () => {
    const text = para(500, 'palabra');
    const parts = chunkText(text, 300);
    for (const p of parts) {
      expect(Array.from(p).length).toBeLessThanOrEqual(300);
      expect(p.startsWith('palabra')).toBe(true);
      expect(p.endsWith('palabra')).toBe(true);
    }
    expect(parts.join(' ')).toBe(text);
  });

  it('un bloque de código partido se cierra y se reabre', () => {
    const code = Array.from({ length: 80 }, (_, i) => `const linea${i} = ${i};`).join('\n');
    const text = `Aquí va el código:\n\n\`\`\`\n${code}\n\`\`\`\n\nFin.`;
    const parts = chunkText(text, 600);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(Array.from(p).length).toBeLessThanOrEqual(600);
      expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(parts.at(-1)?.endsWith('Fin.')).toBe(true);
  });

  it('respeta el tope de Telegram con texto real largo', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Párrafo ${i}. ${para(40, 'texto')}.`).join(
      '\n\n',
    );
    const parts = chunkText(text, 4000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(Array.from(p).length).toBeLessThanOrEqual(4000);
      expect(p.startsWith('Párrafo')).toBe(true);
    }
  });
});
