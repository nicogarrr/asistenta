import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

const html = renderPage();
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

function luminancia(hex: string): number {
  const h = hex.replace('#', '');
  const lin = (i: number) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}
function contraste(a: string, b: string): number {
  const x = luminancia(a);
  const y = luminancia(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function variable(nombre: string): string {
  const m = css.match(new RegExp(`--${nombre}: (#[0-9a-f]{6})`));
  if (!m?.[1]) throw new Error(`falta --${nombre}`);
  return m[1];
}

describe('panel: contraste y foco', () => {
  it('ningún texto baja de 11 px y los textos grises secundarios van a 13 px', () => {
    const tamanos = [...css.matchAll(/font-size: (\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...tamanos)).toBeGreaterThanOrEqual(11);
    for (const regla of [
      '.recuerdo .muted',
      '.sesion .muted',
      '.turno .quien',
      'summary',
      '.subtitulo',
    ]) {
      const linea = css.split('\n').find((l) => l.trim().startsWith(`${regla} {`));
      expect(linea, regla).toMatch(/font-size: 13px/);
    }
  });

  it('el gris de apoyo y los placeholders llegan a 4.5:1 sobre los fondos del panel', () => {
    for (const fondo of ['fondo', 'panel', 'panel-2']) {
      expect(contraste(variable('suave'), variable(fondo))).toBeGreaterThanOrEqual(4.5);
    }
    const placeholders = [...css.matchAll(/::placeholder \{ color: (#[0-9a-f]{6})/g)].map(
      (m) => m[1] ?? '',
    );
    expect(placeholders.length).toBeGreaterThan(0);
    for (const color of placeholders)
      expect(contraste(color, variable('panel-2'))).toBeGreaterThanOrEqual(4.5);
  });

  it('botones, enlaces y desplegables tienen anillo de foco con halo oscuro', () => {
    expect(css).toMatch(
      /button:focus-visible,\s*a:focus-visible,\s*summary:focus-visible \{[^}]*outline: 2px solid var\(--acento\);[^}]*box-shadow: 0 0 0 4px var\(--fondo\);/,
    );
  });

  it('«Saltar al contenido» lleva a un destino que puede recibir el foco', () => {
    expect(html).toContain('<a class="skip" href="#contenido">Saltar al contenido</a>');
    expect(html).toContain('<main id="contenido" tabindex="-1">');
  });
});
