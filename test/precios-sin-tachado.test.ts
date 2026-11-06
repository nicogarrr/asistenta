import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ItemListado, parseListado } from '../src/precios/amazon.js';
import { claveModelo, referenciaPares } from '../src/precios/regla.js';
import { VigilantePrecios } from '../src/precios/vigilante.js';

// Muestras reales recortadas (amazon.es / camelcamelcamel, 6-nov-2026).
const fx = (n: string) => readFileSync(join('test', 'fixtures', 'amazon', n), 'utf8');

// Forma real de un resultado de búsqueda (copiada de busqueda-robot-aspirador.html), SIN tachado.
const resultado = (asin: string, titulo: string, precio: string) =>
  `<div role="listitem" data-asin="${asin}" data-component-type="s-search-result" class="sg-col-4-of-24">` +
  `<h2 aria-label="${titulo}" class="a-size-base-plus"><span>${titulo}</span></h2>` +
  `<a class="a-link-normal" href="/x/dp/${asin}/"><span class="a-price" data-a-size="xl" data-a-color="base"><span class="a-offscreen">${precio}</span><span aria-hidden="true">x</span></span></a>` +
  '</div>';

// Lo que había en «ghd gold» el 6-nov: ghd Gold de 185 a 239 €, ninguna con tachado.
const GHD = 'B0GHDERR01';
const PAGINA =
  resultado(
    'B0H7L5F396',
    'ghd Gold - Plancha de pelo profesional, placas de 2,5 cm',
    '199,20\u00a0€',
  ) +
  resultado('B0CFFTMVJN', 'ghd Gold Plancha de Pelo Profesional, Negro', '195,99\u00a0€') +
  resultado('B0GHDPEER3', 'ghd Gold Styler plancha profesional edición regalo', '239,00\u00a0€') +
  resultado('B0GHDPEER4', 'ghd Gold Professional Styler', '185,00\u00a0€') +
  resultado('B0OTRAMARC', 'Remington Plancha de pelo Keratin Protect', '39,99\u00a0€') +
  resultado(GHD, 'ghd Gold Professional Plancha de pelo profesional', '29,90\u00a0€');

function ficha(): string {
  return fx('ficha-dreo-navegador.html')
    .replace(
      /(<span id="productTitle"[^>]*>)[\s\S]*?(<\/span>)/,
      '$1 ghd Gold Professional Plancha de pelo $2',
    )
    .replace('a-price-whole">41', 'a-price-whole">29')
    .replace('a-price-fraction">31', 'a-price-fraction">90')
    .replace(/Remitente \/ Vendedor/g, 'Envío desde: Amazon.es Vendido por: Amazon.es Detalles');
}

function vigilante(historial: () => Promise<{ status: number; html: string }>) {
  const avisos: string[] = [];
  const abiertas: string[] = [];
  const v = new VigilantePrecios({
    archivo: join(mkdtempSync(join(tmpdir(), 'pr3-pares-')), 'p.json'),
    categorias: [{ id: 'ghd', nombre: 'ghd', urls: ['https://www.amazon.es/s?k=ghd+gold'] }],
    leerListado: async () => ({ status: 200, html: PAGINA }),
    leerFicha: async (u) => {
      abiertas.push(u);
      return { status: 200, html: ficha() };
    },
    leerHistorial: historial,
    avisar: async (t) => void avisos.push(t),
    esperar: async () => undefined,
    now: () => 1_800_000_000_000,
  });
  return { v, avisos, abiertas };
}

describe('precios: listado sin tachado comparado con sus iguales de la página', () => {
  it('clave marca + modelo', () => {
    expect(claveModelo('ghd Gold - Plancha de pelo')).toBe('ghd gold');
    expect(claveModelo('Apple iPhone 15 (128 GB) - Negro')).toBe('apple iphone 15 128');
  });

  it('la ghd Gold a 29,90 € sin tachado es candidata (mediana de 4 iguales ≈197 €); la Remington no cuenta', () => {
    const items = parseListado(PAGINA);
    const de = (asin: string): ItemListado => {
      const it = items.find((i) => i.asin === asin);
      if (!it) throw new Error(`falta ${asin}`);
      return it;
    };
    const ghd = de(GHD);
    expect(ghd.refCents).toBeNull();
    expect(referenciaPares(ghd, items)).toBe(19760);
    // Con solo 2 iguales no basta.
    expect(referenciaPares(ghd, [de('B0H7L5F396'), de('B0CFFTMVJN'), ghd])).toBeNull();
    // Una de 185 € no está a ≤40 % de la mediana.
    expect(referenciaPares(de('B0GHDPEER4'), items)).toBeNull();
  });

  it('avisa solo tras confirmarlo con camelcamelcamel (último precio real 211,65 €)', async () => {
    const { v, avisos, abiertas } = vigilante(async () => ({
      status: 200,
      html: fx('camel-ghd-gold-solo-actual.html'),
    }));
    const r = await v.barrer();
    expect(abiertas).toEqual([`https://www.amazon.es/dp/${GHD}`]);
    expect(r?.avisos).toBe(1);
    expect(avisos[0]).toContain('🚨 ERROR DE PRECIO');
    expect(avisos[0]).toContain('29,90 €');
    expect(avisos[0]).toContain('211,65 €');
  });

  it('sin histórico real que lo confirme no avisa (queda pendiente)', async () => {
    const { v, avisos } = vigilante(async () => ({ status: 503, html: '' }));
    await v.barrer();
    expect(avisos).toEqual([]);
    expect(v.leer().pendientes[0]?.asin).toBe(GHD);
  });
});
