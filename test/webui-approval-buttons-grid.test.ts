import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

describe('panel: botones de aprobación', () => {
  const html = renderPage();
  const regla = /\.aprobacion \.botones \{([^}]*)\}/.exec(html)?.[1] ?? '';

  it('van en rejilla de columnas iguales (Denegar no queda solo en otra fila)', () => {
    expect(regla).toContain('display: grid');
    expect(regla).toMatch(/grid-template-columns: repeat\(auto-fill, minmax\(11\.5rem, 1fr\)\)/);
    expect(regla).not.toContain('flex-wrap');
  });

  it('siguen sin partir el texto ni perder el área táctil', () => {
    expect(html).toMatch(/\.aprobacion \.botones button \{ white-space: nowrap; \}/);
    expect(html).toMatch(/\.aprobacion \.botones button \{[^}]*min-height: 40px/);
  });
});
