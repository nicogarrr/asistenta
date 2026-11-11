import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bibliotecaElegir, bibliotecaOrden, bibliotecaVista } from '../src/biblioteca.js';
import { CreadosStore } from '../src/creados.js';

// bugs-36 (lead de bugs-35, revisión de #2344): tras «/biblioteca pdf» la lista numera los
// PDF (1, 2…) y la ayuda decía «/biblioteca fijar N», pero «fijar N» cuenta en la lista
// ENTERA: «fijar 1» fijaba lo último que se hizo (una gráfica), no el PDF que veía.

describe('/biblioteca fijar N después de una lista filtrada', () => {
  let dir = '';
  let t = Date.UTC(2026, 10, 1, 9);
  let store: CreadosStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-fijar-'));
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

  it('la ayuda de la lista de PDF dice «/biblioteca pdf fijar N», y eso fija el PDF que ves', () => {
    const informe = guardar('informe-q3.pdf');
    guardar('grafica.png');
    const lista = store.lista();
    const v = bibliotecaVista(lista, 'pdf' as never, t);
    expect(v.text).toContain('1. 📄 informe-q3.pdf');
    expect(v.text).toContain('«/biblioteca pdf fijar N»');
    expect(v.text).toContain('«/biblioteca pdf N»');
    expect(v.text).not.toContain('«/biblioteca fijar N»');
    expect(bibliotecaOrden('pdf fijar 1')).toEqual({ kind: 'fijar', n: 1, filtro: 'pdf' });
    expect(bibliotecaOrden('fijar graficas 1')).toEqual({ kind: 'fijar', n: 1, filtro: 'imagen' });
    expect(bibliotecaElegir(lista, bibliotecaOrden('pdf fijar 1'))?.id).toBe(informe);
    // Sin tipo sigue contando en la lista entera.
    expect(bibliotecaElegir(lista, bibliotecaOrden('fijar 1'))?.nombre).toBe('grafica.png');
  });

  it('en una búsqueda no promete números que no casan: solo los botones', () => {
    guardar('factura-octubre.pdf');
    guardar('grafica.png');
    const v = bibliotecaVista(store.lista(), null, t, new Set(), 'factura');
    expect(v.text).not.toContain('«/biblioteca fijar N»');
    expect(v.text).not.toContain('«/biblioteca N»');
    expect(v.text).toContain('📌 Fijar');
    expect(v.pins).toHaveLength(1);
  });

  it('un tipo que no existe no se lee como otra cosa', () => {
    expect(bibliotecaOrden('cosas fijar 1')).toMatchObject({ kind: 'ayuda' });
    expect(bibliotecaOrden('fijar 3')).toEqual({ kind: 'fijar', n: 3 });
  });
});
