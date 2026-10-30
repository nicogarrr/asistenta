import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPTION_MAX, fitCaption } from '../src/channels/telegram.js';

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('fitCaption: pie de archivo dentro de 1024', () => {
  it('un pie corto no cambia', () => {
    expect(fitCaption('informe.pdf')).toBe('informe.pdf');
    expect(fitCaption('a'.repeat(CAPTION_MAX))).toBe('a'.repeat(CAPTION_MAX));
  });

  it('no parte un emoji justo en el límite', () => {
    const text = `${'a'.repeat(CAPTION_MAX - 2)}📖📖📖`;
    const out = fitCaption(text);
    expect(out.length).toBeLessThanOrEqual(CAPTION_MAX);
    expect(out).not.toMatch(lone);
    expect(out.endsWith('…')).toBe(true);
  });

  it('corta en un espacio y marca con «…» que falta texto', () => {
    const text = 'palabra '.repeat(200);
    const out = fitCaption(text);
    expect(out.length).toBeLessThanOrEqual(CAPTION_MAX);
    expect(out.endsWith('palabra…')).toBe(true);
  });

  it('el adaptador ya no recorta pies con slice a ciegas', () => {
    expect(readFileSync('src/channels/telegram.ts', 'utf8')).not.toContain('.slice(0, 1024)');
  });
});
