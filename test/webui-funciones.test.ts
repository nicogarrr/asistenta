import { describe, expect, it } from 'vitest';
import { funcionCommands } from '../src/funciones.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

const base: WebUiDeps = {
  token: 'test-only',
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
};
const headers = { Authorization: 'Bearer test-only' };

interface Area {
  id: string;
  titulo: string;
  resumen: string;
  ejemplo: string;
  comandos: { comando: string; descripcion: string }[];
  habilidades: string[];
}

describe('panel: vista Funciones (la misma lista que /funciones en Telegram)', () => {
  it('GET /api/funciones pide token y devuelve las áreas con sus comandos', async () => {
    const ui = await startWebUi(base);
    try {
      expect((await fetch(`${ui.url}/api/funciones`)).status).toBe(401);
      const res = await fetch(`${ui.url}/api/funciones`, { headers });
      expect(res.status).toBe(200);
      const areas = (await res.json()) as Area[];
      expect(areas.length).toBeGreaterThan(3);
      for (const a of areas) {
        expect(a.titulo).toBeTruthy();
        expect(a.resumen).toBeTruthy();
        expect(a.ejemplo).toBeTruthy();
        expect(
          a.comandos.length + a.habilidades.length,
          `área ${a.id} sin comandos ni habilidades`,
        ).toBeGreaterThan(0);
        for (const c of a.comandos) expect(c.comando.startsWith('/')).toBe(true);
      }
      const todos = areas.flatMap((a) => a.comandos.map((c) => c.comando.split(' ')[0]));
      expect(todos).toContain('/funciones');
      // Mismo catálogo que Telegram: cada comando sale una vez, ninguno se pierde.
      expect(new Set(todos).size).toBe(todos.length);
      expect(todos.length).toBe(funcionCommands().length);
    } finally {
      await ui.close();
    }
  });

  it('solo lectura: otros métodos no cambian nada', async () => {
    const ui = await startWebUi(base);
    try {
      const res = await fetch(`${ui.url}/api/funciones`, { method: 'POST', headers, body: '{}' });
      expect(res.status).not.toBe(200);
    } finally {
      await ui.close();
    }
  });

  it('la página tiene la tarjeta Funciones, con su Refrescar, y la carga al refrescar todo', () => {
    const html = renderPage();
    expect(html).toContain('aria-labelledby="titulo-funciones"');
    expect(html).toContain('id="panel-funciones"');
    expect(html).toContain('data-refrescar="funciones"');
    expect(html).toContain("pedir('/api/funciones')");
    expect(html).toMatch(/funciones: cargarFunciones/);
    expect(html).toMatch(/cargarRutinas\(\),\s*cargarFunciones\(\)/);
  });
});
