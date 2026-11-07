import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fuentesDesde, parseFuente, urlPista } from '../src/precios/fuentes.js';
import { VigilantePrecios } from '../src/precios/vigilante.js';

// Caso real 7-nov-2026: «RexingUSA Cámara de salpicadero V1-4K» (B0BSJZPSJP), ~170 € esa semana
// (Keepa), a 19,73 € de un vendedor externo. Nº29.026 en Electrónica, de 2023: no está en ningún
// «más vendidos» ni en las novedades, y en su búsqueda no hay 3 iguales. Solo lo vieron las
// cuentas de chollos. Las fuentes dan la PISTA; la ficha y el histórico real deciden.
const fx = (n: string) => readFileSync(join('test', 'fixtures', 'amazon', n), 'utf8');
const ASIN = 'B0BSJZPSJP';
const TITULO =
  'RexingUSA Cámara de salpicadero de Coche V1-4K Ultra HD GPS con Pantalla LCD de 2.4 Pulgadas';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:pepper="https://www.chollometro.com"><channel>
<item><category><![CDATA[Electrónica]]></category><pepper:merchant name="Amazon" price="19,73€"/>
<title><![CDATA[${TITULO}]]></title><link>https://www.chollometro.com/ofertas/rexing-v1-4k-2059001</link>
<guid>https://www.chollometro.com/ofertas/rexing-v1-4k-2059001</guid></item>
<item><pepper:merchant name="MediaMarkt" price="99€"/><title><![CDATA[Sony WH-1000XM5]]></title>
<link>https://www.chollometro.com/ofertas/sony-2059002</link></item>
</channel></rss>`;

const TELEGRAM = `<div class="tgme_widget_message" data-post="DealRadarSpain/4521"><div class="tgme_widget_message_text js-message_text" dir="auto">🚨 ERROR DE PRECIO 19.73€ (antes 132€)<br/><b>${TITULO}</b><br/><a href="https://www.amazon.es/dp/${ASIN}?tag=deal-21">https://www.amazon.es/dp/${ASIN}?tag=deal-21</a></div></div>
<div class="tgme_widget_message" data-post="DealRadarSpain/4522"><div class="tgme_widget_message_text js-message_text">Sorteo del finde, ¡participa!</div></div>`;

const resultado = (asin: string, titulo: string, precio: string) =>
  `<div role="listitem" data-asin="${asin}" data-component-type="s-search-result" class="sg-col-4-of-24">` +
  `<h2 aria-label="${titulo}" class="a-size-base-plus"><span>${titulo}</span></h2>` +
  `<a class="a-link-normal" href="/x/dp/${asin}/"><span class="a-price" data-a-size="xl" data-a-color="base"><span class="a-offscreen">${precio}</span><span aria-hidden="true">x</span></span></a>` +
  '</div>';

// Búsqueda de la pista: la Rexing SIN tachado y sin iguales (nada que la delate en el listado).
const BUSQUEDA =
  resultado(ASIN, TITULO, '19,73\u00a0€') +
  resultado('B0811Q28N6', 'WOLFBOX G840S Cámara de Coche 2160P 4K Dashcam', '169,99\u00a0€') +
  resultado('B0GX4YGYXG', 'WOLFANG 4K Dashcam 4 Canales con WiFi', '70,24\u00a0€');
const OTRA = resultado('B0OTRO0001', 'Philips Hue Bombilla E27 White', '14,99\u00a0€');

function ficha(titulo = TITULO, vendedor = 'RexingES'): string {
  return fx('ficha-dreo-navegador.html')
    .replace(/(<span id="productTitle"[^>]*>)[\s\S]*?(<\/span>)/, `$1 ${titulo} $2`)
    .replace('a-price-whole">41', 'a-price-whole">19')
    .replace('a-price-fraction">31', 'a-price-fraction">73')
    .replace(
      /Remitente \/ Vendedor/g,
      `Envío desde: ${vendedor} Vendido por: ${vendedor} Detalles`,
    );
}

// Histórico externo real (forma de camelcamelcamel; la cifra es la de la muestra guardada).
const CAMEL = fx('camel-ghd-gold-solo-actual.html');

function montar(o: { fuentes?: string[]; historial?: number; ficha?: string }) {
  const avisos: string[] = [];
  const listados: string[] = [];
  const fichas: string[] = [];
  const v = new VigilantePrecios({
    archivo: join(mkdtempSync(join(tmpdir(), 'pr4-fuentes-')), 'p.json'),
    categorias: [],
    rapidas: [{ id: 'hue', nombre: 'hue', urls: ['https://www.amazon.es/s?k=hue'] }],
    ...(o.fuentes ? { fuentes: o.fuentes } : {}),
    leerFuente: async (u) => ({ status: 200, html: u.includes('t.me') ? TELEGRAM : RSS }),
    leerListado: async (u) => {
      listados.push(u);
      return {
        status: 200,
        html: /Rexing|B0BSJZPSJP/.test(decodeURIComponent(u)) ? BUSQUEDA : OTRA,
      };
    },
    leerFicha: async (u) => {
      fichas.push(u);
      return { status: 200, html: o.ficha ?? ficha() };
    },
    leerHistorial: async () => ({ status: o.historial ?? 200, html: CAMEL }),
    avisar: async (t) => void avisos.push(t),
    esperar: async () => undefined,
    now: () => 1_800_000_000_000,
  });
  return { v, avisos, listados, fichas };
}

describe('precios: fuentes públicas de chollos como pistas', () => {
  it('RSS: solo las ofertas de Amazon; Telegram: los mensajes con enlace de amazon.es', () => {
    expect(parseFuente(RSS)).toEqual([
      {
        id: 'https://www.chollometro.com/ofertas/rexing-v1-4k-2059001',
        titulo: TITULO,
        asin: null,
      },
    ]);
    const tg = parseFuente(TELEGRAM);
    expect(tg).toHaveLength(1);
    expect(tg[0]).toMatchObject({ id: 'tg:DealRadarSpain/4521', asin: ASIN });
    expect(parseFuente('<html>nada</html>')).toEqual([]);
  });

  it('la pista se busca en amazon.es por ASIN o por marca y modelo (sin precio ni «error»)', () => {
    expect(urlPista({ id: 'x', titulo: 'da igual', asin: ASIN })).toBe(
      `https://www.amazon.es/s?k=${ASIN}`,
    );
    const u = new URL(
      urlPista({ id: 'y', titulo: `🚨 ERROR DE PRECIO 19,73€ ${TITULO}`, asin: null }),
    );
    expect(u.searchParams.get('k')).toBe('RexingUSA Cámara de salpicadero de Coche V1-4K Ultra');
  });

  it('PA_PRECIOS_FUENTES: por defecto el RSS de Chollometro; «no» = ninguna', () => {
    expect(fuentesDesde(undefined)).toEqual(['https://www.chollometro.com/rss']);
    expect(fuentesDesde('no')).toEqual([]);
    expect(fuentesDesde('https://t.me/s/canal, http://inseguro, x')).toEqual([
      'https://t.me/s/canal',
    ]);
  });

  it('sin fuentes, la Rexing a 19,73 € no sale (lo que pasó el 7-nov)', async () => {
    const { v, avisos } = montar({});
    await v.barrer({ rapido: true });
    expect(avisos).toEqual([]);
  });

  it('con la pista (Telegram con ASIN): ficha + histórico real → aviso marcado «vendedor externo»', async () => {
    const { v, avisos, listados, fichas } = montar({ fuentes: ['https://t.me/s/DealRadarSpain'] });
    const r = await v.barrer({ rapido: true });
    expect(listados[0]).toBe(`https://www.amazon.es/s?k=${ASIN}`);
    expect(fichas).toEqual([`https://www.amazon.es/dp/${ASIN}`]);
    expect(r?.avisos).toBe(1);
    expect(avisos[0]).toContain('🚨 ERROR DE PRECIO');
    expect(avisos[0]).toContain('⚠️ vendedor externo: RexingES');
    expect(avisos[0]).toContain('19,73 €');
    expect(avisos[0]).toContain('211,65 €');
    // La misma pista no se vuelve a buscar.
    listados.length = 0;
    await v.barrer({ rapido: true });
    expect(listados.some((u) => u.includes(ASIN))).toBe(false);
  });

  it('con la pista del RSS (sin ASIN) la encuentra por marca y modelo', async () => {
    const { v, avisos } = montar({ fuentes: ['https://www.chollometro.com/rss'] });
    await v.barrer({ rapido: true });
    expect(avisos).toHaveLength(1);
  });

  it('vendedor externo sin histórico real: no avisa (queda pendiente)', async () => {
    const { v, avisos } = montar({ fuentes: ['https://t.me/s/DealRadarSpain'], historial: 503 });
    await v.barrer({ rapido: true });
    expect(avisos).toEqual([]);
    expect(v.leer().pendientes[0]?.asin).toBe(ASIN);
  });

  it('vendedor externo sin marca: no avisa', async () => {
    const { v, avisos } = montar({
      fuentes: ['https://t.me/s/DealRadarSpain'],
      ficha: ficha('Cámara de salpicadero 4K WiFi GPS para coche', 'ShopXYZ').replace(
        /DREO/g,
        'Genérico',
      ),
    });
    await v.barrer({ rapido: true });
    expect(avisos).toEqual([]);
  });
});
