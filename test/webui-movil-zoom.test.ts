import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// iPhone (Safari) amplía la página al enfocar un campo con letra de menos de 16 px:
// en el móvil (390 px) el panel quedaba ampliado y había que pellizcar para volver.
// Sin navegador: se lee el CSS de la página.
const html = renderPage();
function bloqueMovil(): string {
  const i = html.indexOf('@media (max-width: 780px)');
  expect(i).toBeGreaterThan(0);
  let nivel = 0;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') nivel++;
    if (html[j] === '}' && --nivel === 0) return html.slice(i, j + 1);
  }
  throw new Error('bloque sin cerrar');
}
function tamanoEnMovil(selector: string): number {
  const bloque = bloqueMovil().replace(/\/\*[\s\S]*?\*\//g, '');
  let mejor = 0;
  for (const m of bloque.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectores = (m[1] ?? '').split(',').map((s) => s.trim());
    const tam = /font-size:\s*(\d+)px/.exec(m[2] ?? '');
    if (tam && selectores.includes(selector)) mejor = Math.max(mejor, Number(tam[1]));
  }
  return mejor;
}

describe('panel en el móvil: los campos no hacen zoom al tocarlos', () => {
  it('cada campo de texto de la página está en .buscador o .token', () => {
    const campos = html.match(/<(input|textarea|select)\b[^>]*>/g) ?? [];
    expect(campos.length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(/class="aviso token"[\s\S]*?<input id="campo-token"/);
    for (const id of ['texto-chat', 'buscar-sesiones', 'ambito-memoria']) {
      expect(html).toMatch(new RegExp(`<label class="buscador" for="${id}">`));
    }
  });

  it.each(['.buscador input', '.buscador select', '.buscador textarea', '.token input'])(
    '%s tiene al menos 16 px a ≤ 780 px',
    (selector) => {
      expect(tamanoEnMovil(selector)).toBeGreaterThanOrEqual(16);
    },
  );
});
