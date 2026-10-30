import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Humo del script de la página sin dependencias nuevas: el script vive dentro de una plantilla
// de texto, así que tsc no lo ve. Aquí se compila tal cual llega al navegador y se comprueba
// que cada id que busca existe en el HTML (o lo crea el propio script).
const html = renderPage();
const inicio = html.lastIndexOf('<script>');
const fin = html.lastIndexOf('</script>');
const script = html.slice(inicio + '<script>'.length, fin);
const marcado = html.slice(0, inicio);

describe('panel: humo del script de la página', () => {
  it('el script compila como JavaScript de navegador', () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });

  it('cada getElementById apunta a un id que existe', () => {
    const buscados = new Set(
      [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1] ?? ''),
    );
    const creados = new Set([...script.matchAll(/\.id = '([^']+)'/g)].map((m) => m[1] ?? ''));
    expect(buscados.size).toBeGreaterThan(10);
    const faltan = [...buscados].filter(
      (id) => !marcado.includes(`id="${id}"`) && !creados.has(id),
    );
    expect(faltan).toEqual([]);
  });

  it('cada botón «Refrescar» de tarjeta tiene su carga en el script', () => {
    const tarjetas = [...marcado.matchAll(/data-refrescar="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(tarjetas.length).toBeGreaterThan(2);
    for (const nombre of tarjetas) expect(script, nombre).toContain(nombre);
  });
});
