import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Restos de letra de 11–12 px en el panel: en un móvil (390 px) se leen mal.
const html = renderPage();
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));

describe('panel: ningún texto por debajo de 13 px', () => {
  it('todas las reglas con font-size en px van a 13 px o más', () => {
    const pequenos = [...css.matchAll(/([^{}]+)\{[^}]*?font-size: (\d+(?:\.\d+)?)px/g)]
      .filter((m) => Number(m[2]) < 13)
      .map((m) => `${(m[1] ?? '').trim()}: ${m[2]}px`);
    expect(pequenos).toEqual([]);
  });

  it('los botones pequeños, chips, contadores y el buscador también', () => {
    for (const sel of [
      'button.mini',
      '.chip',
      '.contador',
      '.buscador',
      '.actualizado',
      '.datos dt',
    ]) {
      const i = css.indexOf(`${sel} {`);
      expect(i, sel).toBeGreaterThan(-1);
      const regla = css.slice(i, css.indexOf('}', i));
      const px = Number(regla.match(/font-size: (\d+)px/)?.[1] ?? 13);
      expect(px, sel).toBeGreaterThanOrEqual(13);
    }
  });
});
