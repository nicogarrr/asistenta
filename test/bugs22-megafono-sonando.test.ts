/**
 * Megáfono (#1907): la confirmación sale al ENCOLAR la nota, antes de que suene. Decía
 * «🔊 Sonó en el PC.» y, si la descarga fallaba, llegaba después «No he podido soltarla»:
 * se contradecían. Nico (2 nov, 23:04) eligió «🔊 Sonando…». La tele, igual.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { altavozConfirmText } from '../src/audio/altavoz-inbound.js';

describe('confirmación del megáfono', () => {
  it('dice que está sonando, no que ya sonó', () => {
    expect(altavozConfirmText('pc')).toBe('🔊 Sonando…');
    expect(altavozConfirmText('tele')).toBe('📺 Sonando en la tele…');
  });

  it('la guía dice lo mismo que el código', () => {
    const doc = readFileSync('docs/audio-altavoz.md', 'utf8');
    expect(doc).toContain('«🔊 Sonando…»');
    expect(doc).toContain('«📺 Sonando en la tele…»');
    expect(doc).not.toMatch(/Sonó en (el PC|la tele)/);
  });
});
