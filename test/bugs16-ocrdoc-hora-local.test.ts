import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMarkdown } from '../src/ocrdoc/engine.js';

// bugs16: la cabecera del .md que deja el OCR de documentos ponía la hora en UTC
// («Convertido: 2026-11-02 05:23 UTC») cuando en Madrid eran las 06:23.
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
});

describe('OCR de documentos: la hora de conversión en hora local', () => {
  it('«Convertido: 2026-11-02 06:23», sin UTC', () => {
    const md = buildMarkdown({
      name: 'factura.pdf',
      at: new Date(Date.UTC(2026, 10, 2, 5, 23)),
      texts: [],
      pages: [],
    });
    expect(md).toContain('> Convertido: 2026-11-02 06:23 · Páginas: 0');
    expect(md).not.toContain('UTC');
  });
});
