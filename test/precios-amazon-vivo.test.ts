import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFicha, parseListado, parseOfertas } from '../src/precios/amazon.js';
import { mejorReferencia } from '../src/precios/regla.js';
import { RAPIDAS_POR_DEFECTO } from '../src/precios/vigilante.js';

// Fallos vistos al cazar en amazon.es real desde un navegador en Madrid (6-nov-2026).
const fx = (n: string) => readFileSync(join('test', 'fixtures', 'amazon', n), 'utf8');

describe('amazon.es real en navegador: ficha de 3 MB', () => {
  // La caja de compra real, con lo que la precede en la página de verdad (~500 KB de cabecera).
  const ficha = `<html><body>${'<div class="x">relleno de cabecera</div>\n'.repeat(12_500)}${fx('ficha-huawei-caja-lejos.html')}`;
  it('lee «Remitente / Vendedor: Amazon» aunque la caja esté pasados los 400 KB', () => {
    expect(ficha.length).toBeGreaterThan(450_000);
    const f = parseFicha(ficha);
    expect(f.cents).toBe(19_900);
    expect(f.vendedor).toBe('Amazon');
    expect(f.envio).toBe('Amazon');
    expect(f.enStock).toBe(true);
  });
  it('el vendedor nunca sale con trozos de HTML', () => {
    expect(parseFicha(ficha).vendedor ?? '').not.toMatch(/[<>"=]/);
  });
});

describe('amazon.es real en navegador: dos bloques de precio', () => {
  const f = parseFicha(fx('ficha-tablet-oferta-flash.html'));
  it('el tachado «precio más bajo de los últimos 30 días» sale de la columna central', () => {
    expect(f).toMatchObject({ cents: 8299, refCents: 29_999, refTipo: 'mas-bajo-reciente' });
  });
  it('oferta flash sin texto de stock pero con «Añadir a la cesta» cuenta como en stock', () => {
    expect(f.enStock).toBe(true);
  });
  it('vendedor externo enviado por Amazon', () => {
    expect(f).toMatchObject({ vendedor: 'PINGLANG Tech', envio: 'Amazon' });
  });
  it('el nombre del vendedor repetido en la ficha real sale una sola vez', () => {
    const caja =
      '<div id="fulfillerInfoFeature_feature_div">Envío desde Amazon</div>' +
      '<div>Vendido por</div><div>RUIMEN</div><div>RUIMEN</div><div>Vendido por RUIMEN</div><div>Devoluciones</div>';
    expect(parseFicha(caja).vendedor).toBe('RUIMEN');
  });
});

describe('amazon.es real en navegador: «Ofertas» (/deals)', () => {
  const html = fx('ofertas-deals.html');
  it('saca los productos del JSON incrustado con precio y tachado', () => {
    const its = parseOfertas(html);
    expect(its.map((i) => i.asin)).toEqual(['B0BVMM5L8N', 'B0FGY2HN51', 'B0HGPRWHY9']);
    expect(its[1]).toMatchObject({ cents: 4499, refCents: 8299, refTipo: 'recomendado' });
    expect(its[2]).toMatchObject({ cents: 29_150, refCents: 30_684, refTipo: 'mas-bajo-reciente' });
  });
  it('«Mediano:» es el precio mediano de Amazon, no el recomendado, y vale como referencia', () => {
    const [p] = parseOfertas(html);
    expect(p).toMatchObject({ cents: 5893, refCents: 8167, refTipo: 'mediana' });
    expect(mejorReferencia([], { cents: 8167, tipo: 'mediana' }, false)).toEqual({
      cents: 8167,
      fuente: 'mediana',
    });
  });
  it('parseListado también lee la página de ofertas (antes daba 0 productos)', () => {
    expect(parseListado(html)).toHaveLength(3);
  });
  it('las ofertas entran en el barrido rápido', () => {
    expect(RAPIDAS_POR_DEFECTO).toContain('https://www.amazon.es/deals');
  });
});
