import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREADOS_MAX_FICHEROS, CreadosStore, nombreSeguro } from '../src/creados.js';
import { PaginasVivas, panelPaginas } from '../src/paginas-vivas.js';
import { startWebUi } from '../src/webui/server.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-valor6-creados-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('archivos creados en «Páginas»', () => {
  it('guarda una copia con nombre seguro y los lista del más nuevo al más viejo', () => {
    let t = Date.parse('2026-11-05T10:00:00');
    const store = new CreadosStore(join(dir, 'creados'), () => t);
    const a = store.guardar(Buffer.from('xlsx'), 'Gastos de octubre.xlsx');
    t += 60_000;
    const b = store.guardar(Buffer.from('png'), '../../malo/gráfica.png');
    expect(a).toBe('20261105-100000-Gastos-de-octubre.xlsx');
    expect(b).toMatch(/^20261105-100100-grafica\.png$/);
    expect(store.lista().map((f) => f.nombre)).toEqual(['grafica.png', 'Gastos-de-octubre.xlsx']);
    expect(store.leer(a ?? '')?.mime).toContain('spreadsheetml');
    expect(store.leer('../agent.db')).toBeNull();
    expect(nombreSeguro('C:\\Users\\Nico\\informe final.pdf')).toBe('informe-final.pdf');
  });

  it('se queda con los últimos 40 (no crece sin límite)', () => {
    let t = Date.parse('2026-11-05T10:00:00');
    const store = new CreadosStore(join(dir, 'creados'), () => {
      t += 1_000;
      return t;
    });
    for (let i = 0; i < CREADOS_MAX_FICHEROS + 5; i++) store.guardar(Buffer.from('x'), `g${i}.png`);
    expect(readdirSync(join(dir, 'creados'))).toHaveLength(CREADOS_MAX_FICHEROS);
    expect(store.lista()[0]?.nombre).toBe(`g${CREADOS_MAX_FICHEROS + 4}.png`);
  });

  it('dos en el mismo segundo no se pisan', () => {
    const store = new CreadosStore(join(dir, 'creados'), () => Date.parse('2026-11-05T10:00:00'));
    store.guardar(Buffer.from('1'), 'grafica.png');
    store.guardar(Buffer.from('2'), 'grafica.png');
    expect(store.lista()).toHaveLength(2);
  });

  it('el panel los lista en «Páginas» y se bajan con la clave, como descarga', async () => {
    const creados = new CreadosStore(join(dir, 'creados'));
    const id = creados.guardar(Buffer.from('%PDF-1.4 hola'), 'Resumen gastos.pdf') ?? '';
    const paginas = new PaginasVivas(new DatabaseSync(':memory:'));
    const datos = panelPaginas(paginas, join(dir, 'salidas'), 'Europe/Madrid', creados);
    expect(datos.archivos.map((f) => f.nombre)).toEqual(['Resumen-gastos.pdf']);
    const srv = await startWebUi({
      token: 'secreto',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      paginas: () => datos,
      creado: (x) => creados.leer(x),
    });
    try {
      const base = srv.url.replace(/\/$/, '');
      const auth = { headers: { Authorization: 'Bearer secreto' } };
      expect((await fetch(`${base}/api/creados/${id}`)).status).toBe(401);
      const r = await fetch(`${base}/api/creados/${encodeURIComponent(id)}`, auth);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/pdf');
      expect(r.headers.get('content-disposition')).toContain('attachment');
      expect(await r.text()).toBe('%PDF-1.4 hola');
      expect((await fetch(`${base}/api/creados/..%2Fagent.db`, auth)).status).toBe(404);
      expect((await fetch(`${base}/api/creados/no-existe`, auth)).status).toBe(404);
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain('Archivos que te he hecho');
      expect(page).toContain("'/api/creados/'");
    } finally {
      await srv.close();
    }
  });
});
