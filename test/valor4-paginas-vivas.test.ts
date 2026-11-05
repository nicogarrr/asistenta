import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bloquesDePagina,
  createPaginaVivaTool,
  PaginasVivas,
  panelPagina,
  panelPaginas,
  slugPagina,
} from '../src/paginas-vivas.js';
import { Gate } from '../src/permissions.js';
import { startWebUi } from '../src/webui/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'valor4-paginas-'));
  dirs.push(d);
  return d;
};
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('');

describe('páginas vivas', () => {
  it('la tool crea la página y una rutina la rehace (misma página, versión 2)', async () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    const tool = createPaginaVivaTool({ store, allowed: () => true, now: () => 1_000 });
    const a = textOf(
      await tool.execute('t', {
        accion: 'guardar',
        titulo: 'la página de mis gastos',
        contenido: '# Noviembre\n\n| Día | Gasto |\n|---|---|\n| 1 | 12 € |',
      }),
    );
    expect(a).toContain('Página «Mis gastos» creada');
    const b = textOf(
      await tool.execute('t', {
        accion: 'guardar',
        titulo: 'Mis gastos',
        contenido: '# Noviembre\n\n- total: 40 €',
        rutina: 'gastos-cada-manana',
      }),
    );
    expect(b).toContain('actualizada en el panel (versión 2)');
    const p = store.ver('mis-gastos');
    expect(p?.contenido).toBe('# Noviembre\n\n- total: 40 €');
    expect(p?.origen).toBe('rutina gastos-cada-manana');
    expect(store.lista()).toHaveLength(1);
    expect(textOf(await tool.execute('t', { accion: 'lista' }))).toContain(
      'Mis gastos (rutina gastos-cada-manana, 2 versiones)',
    );
    expect(textOf(await tool.execute('t', { accion: 'borrar', titulo: 'mis gastos' }))).toContain(
      'borrada',
    );
    expect(store.lista()).toHaveLength(0);
  });

  it('fuera del chat del dueño no crea nada', async () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    const tool = createPaginaVivaTool({ store, allowed: () => false });
    const out = textOf(await tool.execute('t', { accion: 'guardar', titulo: 'x', contenido: 'y' }));
    expect(out).toContain('solo están en el chat privado del dueño');
    expect(store.lista()).toHaveLength(0);
  });

  it('la Gate: ver/lista es lectura; guardar/borrar escribe solo en local', () => {
    const gate = new Gate();
    expect(
      gate.classifyEffect({ tool: 'pagina_viva', args: { accion: 'lista' }, actor: 't' }),
    ).toBe('lee');
    expect(
      gate.classifyEffect({ tool: 'pagina_viva', args: { accion: 'guardar' }, actor: 't' }),
    ).toBe('escribe-local');
  });

  it('el markdown se parte en bloques de texto (el HTML queda como texto)', () => {
    const b = bloquesDePagina(
      '# Gastos\n\nTotal **40 €** este mes\ny sigue.\n\n- súper: 25 €\n- gasolina: 15 €\n\n| Día | Gasto |\n|---|---:|\n| 1 | <script>x</script> |\n\n## Notas',
    );
    expect(b).toEqual([
      { t: 'h', n: 1, texto: 'Gastos' },
      { t: 'p', texto: 'Total 40 € este mes y sigue.' },
      { t: 'ul', items: ['súper: 25 €', 'gasolina: 15 €'] },
      { t: 'tabla', cabecera: ['Día', 'Gasto'], filas: [['1', '<script>x</script>']] },
      { t: 'h', n: 2, texto: 'Notas' },
    ]);
    expect(slugPagina('Seguimiento del piso!')).toBe('seguimiento-del-piso');
  });

  it('el panel lista páginas y salidas de rutinas, y abre una (rutas validadas)', async () => {
    const store = new PaginasVivas(new DatabaseSync(':memory:'));
    store.guardar('Mis gastos', '- 40 €', 'chat', Date.parse('2026-11-05T08:00:00Z'));
    const salidas = tmp();
    mkdirSync(join(salidas, 'resumen-bolsa'));
    writeFileSync(join(salidas, 'resumen-bolsa', '2026-11-05.md'), '## 08:00\n\nIbex +1 %\n');
    writeFileSync(join(salidas, 'resumen-bolsa', 'notas.txt'), 'no');
    const lista = panelPaginas(store, salidas, 'Europe/Madrid');
    expect(lista.paginas.map((p) => p.id)).toEqual(['mis-gastos']);
    expect(lista.salidas.map((s) => s.id)).toEqual(['salida~resumen-bolsa~2026-11-05']);
    expect(panelPagina(store, salidas, 'salida~resumen-bolsa~2026-11-05')?.bloques).toEqual([
      { t: 'h', n: 2, texto: '08:00' },
      { t: 'p', texto: 'Ibex +1 %' },
    ]);
    expect(panelPagina(store, salidas, 'salida~..~2026-11-05')).toBeNull();
    expect(panelPagina(store, salidas, '../etc')).toBeNull();

    const server = await startWebUi({
      token: 'secreto',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      paginas: () => panelPaginas(store, salidas),
      pagina: (id) => panelPagina(store, salidas, id),
    });
    try {
      const base = server.url.replace(/\/$/, '');
      const auth = { headers: { Authorization: 'Bearer secreto' } };
      expect((await fetch(`${base}/api/paginas`)).status).toBe(401);
      const r = await fetch(`${base}/api/paginas`, auth);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { paginas: unknown[] }).paginas).toHaveLength(1);
      const one = await fetch(`${base}/api/paginas/mis-gastos`, auth);
      expect(((await one.json()) as { bloques: unknown }).bloques).toEqual([
        { t: 'ul', items: ['40 €'] },
      ]);
      expect((await fetch(`${base}/api/paginas/no-existe`, auth)).status).toBe(404);
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain('id="panel-paginas"');
      expect(page).toContain("pedir('/api/paginas')");
    } finally {
      await server.close();
    }
  });
});
