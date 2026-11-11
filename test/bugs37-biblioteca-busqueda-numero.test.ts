import { describe, expect, it } from 'vitest';
import {
  BIBLIOTECA_VISTA_MS,
  bibliotecaConBusqueda,
  bibliotecaElegir,
  bibliotecaOrden,
  bibliotecaVista,
  conVistaAnterior,
} from '../src/biblioteca.js';
import type { Creado } from '../src/creados.js';

const now = Date.parse('2026-11-11T12:00:00+01:00');
const c = (id: string, nombre: string, i: number): Creado => ({
  id,
  nombre,
  bytes: 2048,
  creado: now - i * 3_600_000,
});
// Del más nuevo al más viejo (como creados.lista()).
const lista: Creado[] = [
  c('20261111-110000-grafica.png', 'grafica.png', 1),
  c('20261111-100000-Factura-noviembre.pdf', 'Factura-noviembre.pdf', 2),
  c('20261111-090000-notas.txt', 'notas.txt', 3),
  c('20261111-080000-Factura-octubre.pdf', 'Factura-octubre.pdf', 4),
  c('20261111-070000-Gastos-10-2026.xlsx', 'Gastos-10-2026.xlsx', 5),
  c('20261111-060000-Gastos-09-2026.xlsx', 'Gastos-09-2026.xlsx', 6),
];
const elegir = (args: string, vista?: Parameters<typeof conVistaAnterior>[1]) =>
  bibliotecaElegir(
    lista,
    bibliotecaConBusqueda(lista, conVistaAnterior(bibliotecaOrden(args), vista, now)),
  );

describe('bugs-37: los números de /biblioteca tras una búsqueda', () => {
  it('«/biblioteca factura 2» manda el 2 de «/biblioteca factura» (antes: la ayuda)', () => {
    expect(bibliotecaOrden('factura 2')).toEqual({
      kind: 'enviar',
      n: 2,
      filtro: null,
      busca: 'factura',
    });
    expect(elegir('factura 2')?.nombre).toBe('Factura-octubre.pdf');
    expect(elegir('pdf factura 1')?.nombre).toBe('Factura-noviembre.pdf');
    expect(elegir('buscar factura 1')?.nombre).toBe('Factura-noviembre.pdf');
  });

  it('«/biblioteca gastos 10»: busca «gastos 10» si hay algo que se llama así', () => {
    expect(bibliotecaConBusqueda(lista, bibliotecaOrden('gastos 10'))).toEqual({
      kind: 'lista',
      filtro: null,
      busca: 'gastos 10',
    });
    const v = bibliotecaVista(lista, null, now, new Set(), 'gastos 10');
    expect(v.text).toContain('Gastos-10-2026.xlsx');
    expect(v.text).not.toContain('Gastos-09-2026.xlsx');
  });

  it('un número que no está en la búsqueda: la lista (dice qué hay), no «ya no lo tengo»', () => {
    expect(bibliotecaConBusqueda(lista, bibliotecaOrden('factura 5'))).toEqual({
      kind: 'lista',
      filtro: null,
      busca: 'factura',
    });
    expect(bibliotecaConBusqueda(lista, bibliotecaOrden('contrato 12'))).toEqual({
      kind: 'lista',
      filtro: null,
      busca: 'contrato 12',
    });
  });

  it('«/biblioteca 2» justo después de «/biblioteca factura» es el 2 de esa lista', () => {
    const vista = { filtro: null, busca: 'factura', at: now - 60_000 };
    expect(elegir('2')?.nombre).toBe('Factura-noviembre.pdf');
    expect(elegir('2', vista)?.nombre).toBe('Factura-octubre.pdf');
    // Igual tras «/biblioteca excel».
    expect(elegir('1', { filtro: 'excel', at: now - 60_000 })?.nombre).toBe('Gastos-10-2026.xlsx');
    // fijar también.
    expect(
      bibliotecaElegir(lista, conVistaAnterior(bibliotecaOrden('fijar 2'), vista, now))?.nombre,
    ).toBe('Factura-octubre.pdf');
  });

  it('pasada media hora, o tras «/biblioteca» a secas, vuelve a ser la lista entera', () => {
    const vieja = { filtro: null, busca: 'factura', at: now - BIBLIOTECA_VISTA_MS - 1 };
    expect(elegir('2', vieja)?.nombre).toBe('Factura-noviembre.pdf');
    expect(elegir('2', { filtro: null, at: now - 1000 })?.nombre).toBe('Factura-noviembre.pdf');
    // Lo que ya lleva su tipo o su búsqueda no cambia.
    const vista = { filtro: null, busca: 'factura', at: now - 60_000 };
    expect(elegir('excel 1', vista)?.nombre).toBe('Gastos-10-2026.xlsx');
    expect(elegir('gastos 2', vista)?.nombre).toBe('Gastos-09-2026.xlsx');
  });

  it('la ayuda de una búsqueda dice «/biblioteca factura N»', () => {
    const v = bibliotecaVista(lista, null, now, new Set(), 'factura');
    expect(v.text).toContain('«/biblioteca factura N»');
    expect(bibliotecaVista(lista, 'pdf', now, new Set(), 'factura').text).toContain(
      '«/biblioteca pdf factura N»',
    );
  });

  it('lo de antes sigue igual', () => {
    expect(bibliotecaOrden('3')).toEqual({ kind: 'enviar', n: 3, filtro: null });
    expect(bibliotecaOrden('pdf 2')).toEqual({ kind: 'enviar', n: 2, filtro: 'pdf' });
    expect(bibliotecaOrden('enlaces 2').kind).toBe('ayuda');
    expect(bibliotecaOrden('enviar 2').kind).toBe('ayuda');
    expect(bibliotecaOrden('de la 2').kind).toBe('ayuda');
  });
});
