import { describe, expect, it } from 'vitest';
import { safeName } from '../src/ojo-downloads.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('safeName no parte un emoji al acortar (bugs11)', () => {
  it('un emoji justo en el corte no deja medio carácter suelto', () => {
    // 58 letras + 📄: el corte (59 unidades) caía en mitad del emoji.
    const name = `${'a'.repeat(58)}📄 informe trimestral.pdf`;
    const out = safeName(name);
    expect(loneSurrogate.test(out)).toBe(false);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('a'.repeat(58))).toBe(true);
  });

  it('el texto acortado se puede codificar en UTF-8 sin pérdidas (Telegram lo exige)', () => {
    const out = safeName(`${'b'.repeat(58)}🎬🎬🎬 vídeo de las vacaciones.mp4`);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('los nombres cortos con emoji quedan igual', () => {
    expect(safeName('📄 factura.pdf')).toBe('📄 factura.pdf');
  });
});
