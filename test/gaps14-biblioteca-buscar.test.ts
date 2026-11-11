import { describe, expect, it } from 'vitest';
import { bibliotecaOrden, bibliotecaVista, coincide } from '../src/biblioteca.js';
import type { Creado } from '../src/creados.js';

const now = Date.parse('2026-11-11T12:00:00+01:00');
const c = (id: string, nombre: string, i: number): Creado => ({
  id,
  nombre,
  bytes: 2048,
  creado: now - i * 86_400_000,
});
// 14 archivos: la factura de hace dos semanas ya no sale entre los 10 últimos.
const lista: Creado[] = [
  ...Array.from({ length: 12 }, (_, i) =>
    c(`2026111${i % 10}-1000${String(i).padStart(2, '0')}-g${i}.png`, `grafica-${i}.png`, i),
  ),
  c('20261028-100000-Factura-octubre.pdf', 'Factura-octubre.pdf', 14),
  c('20261027-100000-Gastos-de-octubre.xlsx', 'Gastos-de-octubre.xlsx', 15),
];

describe('gaps-14: /biblioteca <nombre> busca (Grok Bot, buscador de la Library)', () => {
  it('entiende «/biblioteca factura», «buscar …» y «pdf factura»', () => {
    expect(bibliotecaOrden('factura')).toEqual({ kind: 'lista', filtro: null, busca: 'factura' });
    expect(bibliotecaOrden('buscar gastos de octubre')).toEqual({
      kind: 'lista',
      filtro: null,
      busca: 'gastos de octubre',
    });
    expect(bibliotecaOrden('pdf factura')).toEqual({
      kind: 'lista',
      filtro: 'pdf',
      busca: 'factura',
    });
    // Lo de antes sigue igual.
    expect(bibliotecaOrden('pdf')).toEqual({ kind: 'lista', filtro: 'pdf' });
    expect(bibliotecaOrden('3')).toMatchObject({ kind: 'enviar', n: 3 });
    expect(bibliotecaOrden('fijar abc').kind).toBe('ayuda');
    // «pepino 2» es el 2 de la búsqueda «pepino» (bugs-37; antes, la ayuda).
    expect(bibliotecaOrden('pepino 2')).toMatchObject({ kind: 'enviar', n: 2, busca: 'pepino' });
    expect(bibliotecaOrden('de la').kind).toBe('ayuda');
  });

  it('sin tildes ni mayúsculas, y todas las palabras', () => {
    expect(coincide('Gastos-de-octubre.xlsx', 'gastos OCTUBRE')).toBe(true);
    expect(coincide('Gráfica_ventas.png', 'grafica ventas')).toBe(true);
    expect(coincide('Gastos-de-octubre.xlsx', 'gastos noviembre')).toBe(false);
  });

  it('encuentra lo que ya no sale en la lista de 10, con su «📤 N»', () => {
    expect(bibliotecaVista(lista, null, now).text).not.toContain('Factura-octubre.pdf');
    const v = bibliotecaVista(lista, null, now, new Set(), 'factura');
    expect(v.text).toContain('📚 Lo que se llama «factura»: 1');
    expect(v.text).toContain('1. 📄 Factura-octubre.pdf');
    expect(v.sends).toEqual([{ label: '📤 1', clave: '20261028-100000' }]);
    expect(v.pins).toHaveLength(1);
    const pdf = bibliotecaVista(lista, 'excel', now, new Set(), 'octubre');
    expect(pdf.text).toContain('Gastos-de-octubre.xlsx');
    expect(pdf.text).not.toContain('Factura');
  });

  it('nada con ese nombre: lo dice', () => {
    expect(bibliotecaVista(lista, null, now, new Set(), 'contrato').text).toBe(
      '📚 No encuentro nada que se llame «contrato» entre los 14 archivos que te he hecho. /biblioteca para verlos todos.',
    );
  });
});
