import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';
import { startWebUi } from '../src/webui/server.js';

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

  it('cada atributo data-* que el script lee lo escribe el marcado o el propio script', () => {
    const leidos = new Set([
      ...[...script.matchAll(/getAttribute\('(data-[a-z-]+)'\)/g)].map((m) => m[1] ?? ''),
      ...[...script.matchAll(/\[(data-[a-z-]+)[\]=]/g)].map((m) => m[1] ?? ''),
    ]);
    expect(leidos.size).toBeGreaterThan(2);
    const escritos = new Set([
      ...[...script.matchAll(/setAttribute\('(data-[a-z-]+)'/g)].map((m) => m[1] ?? ''),
      ...[...html.matchAll(/\s(data-[a-z-]+)="/g)].map((m) => m[1] ?? ''),
      ...[...script.matchAll(/\s(data-[a-z-]+)=\\?"/g)].map((m) => m[1] ?? ''),
    ]);
    const huerfanos = [...leidos].filter((nombre) => !escritos.has(nombre));
    expect(huerfanos).toEqual([]);
  });

  it('cada ruta /api que pide el script existe en el servidor con ese método', async () => {
    const posts = new Set([...script.matchAll(/enviar\('(\/api\/[^']*)'/g)].map((m) => m[1] ?? ''));
    const rutas = new Set(
      [...script.matchAll(/'(\/api\/[^'?]*)/g)].map((m) => m[1] ?? '').filter((r) => r !== '/api/'),
    );
    expect(rutas.size).toBeGreaterThan(6);
    const panel = await startWebUi({
      token: 't',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    });
    try {
      for (const ruta of rutas) {
        const metodo = posts.has(ruta) ? 'POST' : 'GET';
        // Ruta acabada en «/» = prefijo con id (p. ej. «/api/approvals/» + id).
        const url = new URL(ruta.endsWith('/') ? `${ruta}apr_x` : ruta, panel.url);
        const res = await fetch(url, { method: metodo });
        // Sin token: 401 si la ruta y el método existen; 404/405 si el script pide algo que el servidor no tiene.
        expect(`${metodo} ${ruta} ${res.status}`).toBe(`${metodo} ${ruta} 401`);
      }
    } finally {
      await panel.close();
    }
  });
});
