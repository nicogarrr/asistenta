import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ficha } from '../src/precios/amazon.js';
import { type ItemListado, parseFicha, parseListado, parseOfertas } from '../src/precios/amazon.js';
import { parseCamel, urlCamel } from '../src/precios/historial.js';
import { codigoHistorial, codigoListado } from '../src/precios/red.js';
import {
  candidato,
  descarteListado,
  mejorReferencia,
  sinMarca,
  verificar,
} from '../src/precios/regla.js';
import { RAPIDAS_POR_DEFECTO, textoAviso } from '../src/precios/vigilante.js';

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
    expect(mejorReferencia([], { cents: 8167, tipo: 'mediana' }, true)).toEqual({
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

describe('sin marca fuera y tachado de vendedor externo (Nico, 6-nov-2026: «Quita productos sin marca»)', () => {
  // La tablet que saltó en vivo: 82,99 € «antes» 299,99 € (oferta flash), vende PINGLANG Tech.
  const tablet: ItemListado = {
    asin: 'B0GXF786XL',
    titulo:
      '2026 Tablet 10 Pulgadas Android AI ,12GB RAM+128GB ROM/TF 1TB, 5G WiFi, Bluetooth 5.0, 8000mAh Batería',
    cents: 8299,
    refCents: 29_999,
    refTipo: 'mas-bajo-reciente',
    patrocinado: true,
    desde: false,
    porUnidad: false,
  };
  const ficha = parseFicha(fx('ficha-tablet-oferta-flash.html'));
  it('la tablet sin marca de la oferta flash NO avisa (ni en el listado ni en la ficha)', () => {
    expect(descarteListado(tablet)).toMatch(/sin marca/);
    expect(candidato(tablet, [])).toBeNull();
    expect(verificar(tablet, ficha, [])).toMatchObject({ ok: false });
  });
  it('vendedor externo: su «más bajo de 30 días» no vale solo; con historial propio sí', () => {
    expect(mejorReferencia([], { cents: 29_999, tipo: 'mas-bajo-reciente' }, false)).toBeNull();
    const dia = 24 * 3600 * 1000;
    const h = [0, 1, 2].map((i) => ({ at: i * dia, cents: 29_000 }));
    expect(mejorReferencia(h, { cents: 29_999, tipo: 'mas-bajo-reciente' }, false)).toMatchObject({
      fuente: 'historial',
    });
  });
  it('lee la marca de la ficha real', () => {
    expect(ficha.marca).toBe('DEERTiME');
    expect(parseFicha(fx('ficha-huawei-caja-lejos.html')).marca ?? 'HUAWEI').toBe('HUAWEI');
  });
  it('Genérico, Sin marca, marca vacía y la lista configurable', () => {
    expect(sinMarca('Tablet Android', 'Genérico')).toMatch(/sin marca/);
    expect(sinMarca('Reloj', 'Sin marca')).toMatch(/sin marca/);
    expect(sinMarca('Algo', '')).toMatch(/marca vacía/);
    expect(sinMarca('DEERTiME Tablet A9', 'DEERTiME', ['deertime'])).toMatch(/DEERTiME/);
    expect(sinMarca('HUAWEI Watch GT Runner 2 Smartwatch', 'HUAWEI')).toBeNull();
    expect(sinMarca('ghd Gold Professional Plancha de pelo', null)).toBeNull();
    expect(sinMarca('Chivas Regal Mizunara Blended Scotch Whisky 70 cl', null)).toBeNull();
    expect(
      sinMarca('Reloj Inteligente Mujer Hombre, 1.85" Smartwatch con Llamadas', 'FURUID'),
    ).toMatch(/título genérico/);
    expect(sinMarca('Portátil HP 15s-fq5000ns', 'HP')).toBeNull();
    expect(sinMarca('PcCom Imperial Ordenador Gaming Intel Core i7 RTX 4070', 'PcCom')).toBeNull();
    expect(sinMarca('Ordenador de sobremesa Lenovo Legion Tower 5', 'Lenovo')).toBeNull();
    expect(sinMarca('Mini PC Intel NUC 13 Pro', 'Intel')).toBeNull();
    expect(sinMarca('Mini PC 16GB RAM 512GB SSD Windows 11', '')).toMatch(/sin marca/);
    expect(sinMarca('Memoria RAM G.Skill Trident Z5 DDR5 32GB', 'G.SKILL')).toBeNull();
    expect(sinMarca('Memoria RAM DDR5 32GB 6000MHz para PC', '')).toMatch(/sin marca/);
  });
});

describe('−60 % solo frente a un histórico REAL (Nico, 6-nov 12:08: «que no sea un falso 60 %»)', () => {
  // Sony WH-CH520 en amazon.es (6-nov-2026, vendido por Amazon): 25,49 € con «Recomendado 69,99 €».
  const sony: ItemListado = {
    asin: 'B0BTJD6LCL',
    titulo: 'Sony WH-CH520, Auriculares de diadema inalámbricos Bluetooth, 50 h de batería',
    cents: 2549,
    refCents: 6999,
    refTipo: 'recomendado',
    patrocinado: false,
    desde: false,
    porUnidad: false,
  };
  const fichaSony: Ficha = {
    titulo: sony.titulo,
    marca: 'Sony',
    cents: 2549,
    precioOculto: false,
    refCents: 6999,
    refTipo: 'recomendado',
    enStock: true,
    vendedor: 'Amazon',
    envio: 'Amazon',
    estado: 'nuevo',
  };
  const camel = parseCamel(fx('camel-sony-wh-ch520.html'));
  it('lee la tabla real de camelcamelcamel (fila Amazon: mínimo, máximo, actual, media)', () => {
    expect(camel).toEqual({
      fuente: 'camelcamelcamel',
      campo: 'amazon',
      minimo: 2478,
      maximo: 7000,
      actual: 2690,
      media: 3006,
    });
    expect(urlCamel('B0BTJD6LCL')).toBe('https://es.camelcamelcamel.com/product/B0BTJD6LCL');
  });
  it('el «Recomendado» solo no basta: candidato sí, pero pide histórico real', () => {
    expect(candidato(sony, [])).not.toBeNull();
    expect(verificar(sony, fichaSony, [])).toMatchObject({ ok: false, soloPvp: true });
  });
  it('con su histórico real (media 30,06 €) el Sony a 25,49 € NO es un error', () => {
    expect(verificar(sony, fichaSony, [], undefined, camel)).toMatchObject({ ok: false });
  });
  it('un −60 % real frente al histórico externo sí avisa y dice qué referencia es', () => {
    const ghd = {
      ...sony,
      asin: 'B0GHD00001',
      titulo: 'ghd Gold plancha de pelo',
      cents: 2990,
      refCents: 24900,
    };
    const f = { ...fichaSony, titulo: ghd.titulo, marca: 'ghd', cents: 2990, refCents: 24900 };
    const ext = { ...(camel ?? ({} as never)), minimo: 17_900, media: 22_950 };
    const v = verificar(ghd, f, [], undefined, ext);
    expect(v).toMatchObject({ ok: true, ref: { cents: 22_950, fuente: 'externo' } });
    if (!v.ok) return;
    const txt = textoAviso({
      asin: ghd.asin,
      titulo: ghd.titulo,
      cents: v.cents,
      ref: v.ref,
      vendedor: v.vendedor,
    });
    expect(txt).toContain('histórico real: media en Amazon según camelcamelcamel');
  });
  it('«precio más bajo de los últimos 30 días» de Amazon sí es histórico real', () => {
    expect(mejorReferencia([], { cents: 9000, tipo: 'mas-bajo-reciente' }, true)).toEqual({
      cents: 9000,
      fuente: 'mas-bajo-reciente',
    });
    expect(mejorReferencia([], { cents: 9000, tipo: 'recomendado' }, true)).toBeNull();
  });
});

describe('en el Chrome de Asistenta', () => {
  it('la página de Ofertas devuelve su JSON incrustado (antes el navegador la daba vacía)', () => {
    expect(codigoListado('https://www.amazon.es/deals')).toContain('productSearchResponse');
  });
  it('el histórico externo solo lee la tabla de precios de camelcamelcamel', () => {
    const c = codigoHistorial(urlCamel('B0BTJD6LCL'));
    expect(c).toContain('https://es.camelcamelcamel.com/product/B0BTJD6LCL');
    expect(c).toContain('data-field');
  });
});

describe('ghd Gold real (6-nov-2026): camelcamelcamel sin media y vendedor con nombre largo', () => {
  const ext = parseCamel(fx('camel-ghd-gold-solo-actual.html'));
  it('producto reciente en camelcamelcamel: sin media, pero su último precio real cuenta', () => {
    expect(ext).toMatchObject({ campo: 'amazon', actual: 21_165, media: null });
  });
  it('la ghd Gold vendida por Amazon a 29,90 € avisa frente a su precio real (211,65 €)', () => {
    const it: ItemListado = {
      asin: 'B0H7L5F396',
      titulo: 'ghd Gold - Plancha de Pelo Profesional Avanzada',
      cents: 2990,
      refCents: 24_900,
      refTipo: 'recomendado',
      patrocinado: false,
      desde: false,
      porUnidad: false,
    };
    const f: Ficha = {
      titulo: it.titulo,
      marca: 'ghd',
      cents: 2990,
      precioOculto: false,
      refCents: null,
      refTipo: null,
      enStock: true,
      vendedor: 'Amazon',
      envio: 'Amazon',
      estado: 'nuevo',
    };
    expect(verificar(it, f, [])).toMatchObject({ ok: false, soloPvp: true });
    expect(verificar(it, f, [], undefined, ext)).toMatchObject({
      ok: true,
      ref: { cents: 21_165, fuente: 'externo' },
    });
  });
  it('«Remitente / Vendedor» con nombre de varias palabras sale entero y una vez', () => {
    const caja =
      '<div id="merchantInfoFeature_feature_div">Remitente / Vendedor</div><div>Productos Profesionales AMP</div>' +
      '<div>Productos Profesionales AMP</div><div>Remitente / Vendedor Productos Profesionales AMP</div>';
    expect(parseFicha(caja)).toMatchObject({
      vendedor: 'Productos Profesionales AMP',
      envio: 'Productos Profesionales AMP',
    });
  });
});
