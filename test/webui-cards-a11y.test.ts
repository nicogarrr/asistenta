import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

const html = renderPage();
const tarjetas = [...html.matchAll(/<article([^>]*)>([\s\S]*?)<\/article>/g)].map((m) => ({
  attrs: m[1] ?? '',
  cuerpo: m[2] ?? '',
}));
const mapa = html.slice(
  html.indexOf('var refrescos = {'),
  html.indexOf('};', html.indexOf('var refrescos = {')),
);
const claves = [...mapa.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const textoTitulo = (h2: string) =>
  h2
    .replace(/<span[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();

describe('panel a11y: cada tarjeta tiene título y Refrescar', () => {
  it('hay tarjetas y todas se titulan con su h2 (aria-labelledby)', () => {
    expect(tarjetas.length).toBeGreaterThanOrEqual(8);
    for (const t of tarjetas) {
      const id = /aria-labelledby="([^"]+)"/.exec(t.attrs)?.[1];
      expect(id, t.attrs).toBeTruthy();
      const h2 = new RegExp(`<h2 id="${id}">([\\s\\S]*?)</h2>`).exec(t.cuerpo)?.[1] ?? '';
      expect(textoTitulo(h2), id).not.toBe('');
    }
  });

  it('cada tarjeta de datos (todas menos Chat) tiene un Refrescar con nombre propio que su recarga conoce', () => {
    const vistos: string[] = [];
    for (const t of tarjetas) {
      const id = /aria-labelledby="([^"]+)"/.exec(t.attrs)?.[1] ?? '';
      if (id === 'titulo-chat') continue;
      const titulo = textoTitulo(
        new RegExp(`<h2 id="${id}">([\\s\\S]*?)</h2>`).exec(t.cuerpo)?.[1] ?? '',
      );
      const botones = [
        ...t.cuerpo.matchAll(/<button([^>]*data-refrescar="([^"]+)"[^>]*)>([^<]*)<\/button>/g),
      ];
      expect(botones.length, id).toBe(1);
      const [, attrs, clave, texto] = botones[0] as RegExpMatchArray;
      expect(texto).toBe('Refrescar');
      expect(claves, id).toContain(clave);
      // Con 7 botones «Refrescar», el lector de pantalla tiene que saber cuál es cuál.
      expect(attrs, id).toContain(`aria-label="Refrescar ${titulo}"`);
      vistos.push(clave as string);
    }
    expect(new Set(vistos).size).toBe(vistos.length);
  });
});
