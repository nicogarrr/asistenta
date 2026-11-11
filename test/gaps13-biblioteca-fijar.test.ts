import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bibliotecaElegir,
  bibliotecaOrden,
  bibliotecaVista,
  textoFijar,
} from '../src/biblioteca.js';
import { CREADOS_MAX_FICHEROS, CREADOS_MAX_FIJADOS, CreadosStore } from '../src/creados.js';

describe('gaps-13: /biblioteca fijar N (Grok Bot «Pin» en la Library)', () => {
  let dir = '';
  let t = Date.UTC(2026, 10, 1, 9);
  let store: CreadosStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps13-fijar-'));
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

  it('entiende fijar/soltar N', () => {
    expect(bibliotecaOrden('fijar 3')).toEqual({ kind: 'fijar', n: 3 });
    expect(bibliotecaOrden('Fija 1')).toEqual({ kind: 'fijar', n: 1 });
    expect(bibliotecaOrden('soltar 2')).toEqual({ kind: 'soltar', n: 2 });
    expect(bibliotecaOrden('3')).toMatchObject({ kind: 'enviar', n: 3 });
  });

  it('lo fijado sale arriba con 📌, y «/biblioteca N» cuenta con ese mismo orden', () => {
    const viejo = guardar('informe-q3.pdf');
    guardar('grafica.png');
    guardar('gastos.xlsx');
    const lista = store.lista();
    const c = bibliotecaElegir(lista, bibliotecaOrden('fijar 3'));
    expect(c?.id).toBe(viejo);
    expect(store.fijar(viejo)).toBe('ok');
    expect(store.fijar(viejo)).toBe('ya');
    const fijados = store.fijados();
    const v = bibliotecaVista(lista, null, t, fijados);
    // Con lo fijado y lo de hoy hay dos grupos: «📌 Fijados:» va encima (gaps-15).
    const fila = v.text.split('\n').find((l) => l.startsWith('1. '));
    expect(v.text.split('\n')[1]).toBe('📌 Fijados:');
    expect(fila).toBe(`1. 📌 📄 informe-q3.pdf · 1 KB · ${fila?.split(' · ')[2]}`);
    expect(bibliotecaElegir(lista, bibliotecaOrden('1'), fijados)?.id).toBe(viejo);
    expect(bibliotecaElegir(lista, bibliotecaOrden('pdf 1'), fijados)?.id).toBe(viejo);
    expect(v.text).toContain('«/biblioteca fijar N»');
  });

  it('lo fijado no se poda aunque lleguen 40 más nuevos; al soltarlo vuelve a podarse', () => {
    const viejo = guardar('contrato.pdf');
    expect(store.fijar(viejo)).toBe('ok');
    for (let i = 0; i < CREADOS_MAX_FICHEROS + 3; i++) guardar(`g${i}.png`);
    const ids = store.lista().map((c) => c.id);
    expect(ids).toContain(viejo);
    expect(ids.length).toBe(CREADOS_MAX_FICHEROS + 1);
    expect(store.soltar(viejo)).toBe(true);
    expect(store.soltar(viejo)).toBe(false);
    guardar('otra.png');
    expect(store.lista().map((c) => c.id)).not.toContain(viejo);
    expect(store.lista()).toHaveLength(CREADOS_MAX_FICHEROS);
  });

  it('tope de fijados, archivo que ya no existe y el fichero de fijados no sale en la lista', () => {
    const ids = Array.from({ length: CREADOS_MAX_FIJADOS + 1 }, (_, i) => guardar(`f${i}.pdf`));
    for (const id of ids.slice(0, CREADOS_MAX_FIJADOS)) expect(store.fijar(id)).toBe('ok');
    expect(store.fijar(ids[CREADOS_MAX_FIJADOS] as string)).toBe('lleno');
    expect(store.fijar('20261101-090000-no-existe.pdf')).toBe('no');
    expect(store.fijar('../../etc/passwd')).toBe('no');
    expect(store.lista().some((c) => c.nombre === 'fijados.json')).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'fijados.json'), 'utf8'))).toHaveLength(
      CREADOS_MAX_FIJADOS,
    );
    const c = store.lista()[0] ?? null;
    expect(textoFijar('fijar', c, 'lleno', CREADOS_MAX_FIJADOS)).toContain('tope');
    expect(textoFijar('soltar', null, false, CREADOS_MAX_FIJADOS)).toContain('No tengo ese número');
  });

  it('cli: fijar/soltar no manda el archivo y la lista lleva los fijados', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = cli.indexOf('const cmdBiblioteca = async');
    const cuerpo = cli.slice(i, i + 4500);
    expect(cuerpo).toContain("if (orden.kind === 'fijar' || orden.kind === 'soltar')");
    expect(cuerpo.indexOf("orden.kind === 'fijar'")).toBeLessThan(
      cuerpo.indexOf('sendDocumentBytes'),
    );
    expect(cuerpo).toContain('bib.bibliotecaVista(lista, orden.filtro, Date.now(), fijados');
  });
});
