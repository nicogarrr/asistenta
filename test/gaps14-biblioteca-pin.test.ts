import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bibliotecaElegir,
  bibliotecaOrden,
  bibliotecaVista,
  fijarPorId,
} from '../src/biblioteca.js';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import { CREADOS_MAX_FIJADOS, CreadosStore } from '../src/creados.js';
import { PaginasVivas, panelPaginas } from '../src/paginas-vivas.js';
import { startWebUi } from '../src/webui/server.js';

describe('gaps-14: 📌 con un toque en /biblioteca y en el panel (Grok Bot «Pin»)', () => {
  let dir = '';
  let t = Date.UTC(2026, 10, 1, 9);
  let store: CreadosStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps14-pin-'));
    t = Date.UTC(2026, 10, 1, 9);
    store = new CreadosStore(dir, () => t);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const guardar = (nombre: string): string => {
    t += 60_000;
    const id = store.guardar(Buffer.from(nombre), nombre);
    if (!id) throw new Error('no guardó');
    utimesSync(join(dir, id), t / 1000, t / 1000);
    return id;
  };

  it('cada fila lleva «📌 Fijar N» (o «Soltar N» si ya está fijada) con la clave del archivo', () => {
    const viejo = guardar('informe.pdf');
    guardar('grafica.png');
    expect(store.fijar(viejo)).toBe('ok');
    const v = bibliotecaVista(store.lista(), null, t, store.fijados());
    expect(v.pins.map((p) => [p.label, p.sub])).toEqual([
      ['Soltar 1', 'soltar'],
      ['📌 Fijar 2', 'fijar'],
    ]);
    expect(v.pins.map((p) => p.clave)).toEqual(v.sends.map((s) => s.clave));
    expect(v.text).toContain('«📌 Fijar»');
    expect(v.text).toContain('«/biblioteca fijar N»');
    expect(bibliotecaVista([], null, t).pins).toEqual([]);
  });

  it('el botón usa la clave, no N: sigue siendo el mismo archivo aunque la lista se reordene', () => {
    const a = guardar('a.pdf');
    const b = guardar('b.pdf');
    const vieja = bibliotecaVista(store.lista(), null, t, store.fijados());
    const pinA = vieja.pins.find((p) => p.label.endsWith(' 2'));
    expect(pinA).toBeDefined();
    // Otro mensaje fijó b entre medias: el orden ha cambiado, pero el botón viejo de a sigue siendo a.
    expect(store.fijar(b)).toBe('ok');
    const orden = bibliotecaOrden(`fijar ${pinA?.clave}`);
    expect(orden).toEqual({ kind: 'fijar', n: 0, clave: pinA?.clave });
    expect(bibliotecaElegir(store.lista(), orden, store.fijados())?.id).toBe(a);
    expect(bibliotecaOrden(`soltar ${pinA?.clave}`)).toMatchObject({ kind: 'soltar' });
    // «fijar 3» sigue siendo por número.
    expect(bibliotecaOrden('fijar 3')).toEqual({ kind: 'fijar', n: 3 });
  });

  it('dos archivos del mismo segundo: el botón lleva la huella y fija el correcto', () => {
    const g = store.guardar(Buffer.from('png'), 'grafica.png');
    const x = store.guardar(Buffer.from('xlsx'), 'datos.xlsx');
    const v = bibliotecaVista(store.lista(), null, t, store.fijados());
    for (const p of v.pins) {
      expect(p.clave).toMatch(/-h[0-9a-f]{6}$/);
      const c = bibliotecaElegir(store.lista(), bibliotecaOrden(`fijar ${p.clave}`));
      expect([g, x]).toContain(c?.id);
    }
    expect(new Set(v.pins.map((p) => p.clave)).size).toBe(2);
  });

  it('los botones caben en Telegram y vuelven como orden', () => {
    const id = guardar('presupuesto.xlsx');
    store.guardar(Buffer.from('2'), 'gemela.png');
    const v = bibliotecaVista(store.lista(), null, t, store.fijados());
    for (const p of v.pins) {
      const b = commandButton(p.label, 'biblioteca', p.clave, p.sub);
      expect(b).toBeDefined();
      expect(Buffer.byteLength(b?.action ?? '')).toBeLessThanOrEqual(64);
      expect(commandFromCallback(b?.action ?? '')).toBe(`/biblioteca ${p.sub} ${p.clave}`);
    }
    expect(id).toBeTruthy();
    // Una suborden inventada sigue sin valer.
    expect(commandButton('x', 'biblioteca', '20261101-090100', 'borrar')).toBeUndefined();
  });

  it('desde el panel: fijarPorId fija/suelta por id y el tope se respeta', () => {
    const id = guardar('contrato.pdf');
    expect(fijarPorId(store, id, true, CREADOS_MAX_FIJADOS)).toEqual({
      ok: true,
      mensaje: '📌 Fijado «contrato.pdf»: sale arriba en /biblioteca y no se borra.',
    });
    expect(fijarPorId(store, id, true, CREADOS_MAX_FIJADOS).mensaje).toContain('ya estaba');
    expect(fijarPorId(store, id, false, CREADOS_MAX_FIJADOS).ok).toBe(true);
    expect(store.fijados().has(id)).toBe(false);
    expect(fijarPorId(store, 'no-existe', true, CREADOS_MAX_FIJADOS).ok).toBe(false);
  });

  it('«Páginas» pone lo fijado arriba con fijado: true, y POST /api/creados/fijar lo cambia', async () => {
    const viejo = guardar('viejo.pdf');
    guardar('nuevo.png');
    const paginas = new PaginasVivas(new DatabaseSync(':memory:'));
    const datos = () => panelPaginas(paginas, join(dir, 'salidas'), 'Europe/Madrid', store);
    expect(datos().archivos.map((f) => [f.nombre, f.fijado])).toEqual([
      ['nuevo.png', false],
      ['viejo.pdf', false],
    ]);
    const srv = await startWebUi({
      token: 'secreto',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      paginas: () => datos(),
      fijarCreado: (id, fijar) => fijarPorId(store, id, fijar, CREADOS_MAX_FIJADOS),
    });
    try {
      const base = srv.url.replace(/\/$/, '');
      const post = (body: unknown, auth = true) =>
        fetch(`${base}/api/creados/fijar`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: 'Bearer secreto' } : {}),
          },
          body: JSON.stringify(body),
        });
      expect((await post({ id: viejo, fijar: true }, false)).status).toBe(401);
      expect((await post({ id: viejo })).status).toBe(400);
      expect((await post({ id: 'no-existe', fijar: true })).status).toBe(404);
      const r = await post({ id: viejo, fijar: true });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { mensaje: string }).mensaje).toContain('📌 Fijado');
      expect(datos().archivos.map((f) => [f.nombre, f.fijado])).toEqual([
        ['viejo.pdf', true],
        ['nuevo.png', false],
      ]);
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain("'/api/creados/fijar'");
      expect(page).toContain('📌 Fijar');
    } finally {
      await srv.close();
    }
  });
});
