/**
 * Amazon.es para el vigilante de errores de precio: lectura de listados (búsqueda, «Los más
 * vendidos», «Los que más suben») y de la ficha de un producto. No hace red: recibe el HTML.
 *
 * Lo que se aprendió con páginas reales (test/fixtures/amazon, 6-nov-2026):
 * - Los listados traen el precio aunque se pidan sin navegador; la búsqueda trae además el
 *   tachado («Recomendado: 205,79 €»).
 * - En la búsqueda, un resultado lleva dentro carruseles de OTROS productos con sus precios:
 *   el tachado solo cuenta si va pegado al precio del propio resultado (si no, un robot de
 *   8,79 € se llevaba el «Recomendado: 205,79 €» de otro y parecía un error de precio).
 * - La ficha pedida sin navegador real esconde el precio («Para ver los detalles del
 *   producto, añádelo a la cesta»): eso NO es un precio y no verifica nada.
 * - Amazon responde con un 503 y una página de captcha cuando sospecha de un robot.
 */

import { isBlockedPage, parseEuroCents } from '../watch/price-extract.js';

export const AMAZON_ORIGIN = 'https://www.amazon.es';

/** `pares`: sin tachado; mediana de 3+ iguales (marca y modelo) en la misma página. Solo pista. */
export type RefTipo = 'recomendado' | 'mas-bajo-reciente' | 'mediana' | 'antes' | 'pares';

export interface ItemListado {
  asin: string;
  titulo: string;
  /** Precio del propio resultado, en céntimos (null si no se ve). */
  cents: number | null;
  /** Precio tachado del propio resultado. */
  refCents: number | null;
  refTipo: RefTipo | null;
  patrocinado: boolean;
  /** El precio es «desde …» / «opciones de compra», no el de la oferta principal. */
  desde: boolean;
  /** El precio visible es por unidad, kilo o litro. */
  porUnidad: boolean;
}

export interface Ficha {
  titulo: string;
  cents: number | null;
  /** Amazon no enseña el precio hasta añadirlo a la cesta (o la ficha vino sin navegador). */
  precioOculto: boolean;
  refCents: number | null;
  refTipo: RefTipo | null;
  enStock: boolean | null;
  vendedor: string | null;
  envio: string | null;
  estado: 'nuevo' | 'segunda mano' | 'reacondicionado';
  /** Marca de la ficha («Marca» de la tabla o «Visita la tienda de X»); '' = campo vacío; null = no hay. */
  marca?: string | null;
}

/** Captcha, «¿eres un robot?» o 503/429: hay que parar y esperar, nunca insistir. */
export function esBloqueoAmazon(status: number, html: string): boolean {
  if (isBlockedPage(status, html)) return true;
  return /\/errors\/validateCaptcha|captchacharacters|Escribe los caracteres que ves|Soy humano|robot check/i.test(
    html,
  );
}

const ENTIDADES: Record<string, string> = {
  amp: '&',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: '\u00a0',
  lt: '<',
  gt: '>',
};

export function textoPlano(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|quot|#39|apos|nbsp|lt|gt);/g, (_, e: string) => ENTIDADES[e] ?? ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function euros(raw: string | undefined): number | null {
  if (!raw) return null;
  return parseEuroCents(textoPlano(raw), { plainSpaceThousands: true });
}

/**
 * Importe de un `a-price` a partir de su HTML (desde la clase hasta ~600 caracteres después):
 * el `a-offscreen` si trae cifra; si viene vacío (la ficha lo rellena con JavaScript), las
 * partes visibles `a-price-whole` + `a-price-fraction`.
 */
function importe(trozo: string): number | null {
  const off = euros(/class="a-offscreen">([^<]*)</.exec(trozo)?.[1]);
  if (off !== null) return off;
  const ent = /class="a-price-whole">([\d.\u00a0]+)/.exec(trozo)?.[1];
  if (!ent) return null;
  const dec = /class="a-price-fraction">(\d{1,2})</.exec(trozo)?.[1] ?? '00';
  return euros(`${ent},${dec} €`);
}

function refTipoDe(etiqueta: string): RefTipo {
  if (/m[aá]s bajo/i.test(etiqueta)) return 'mas-bajo-reciente';
  // «Mediano:» de las ofertas: el precio mediano que calcula Amazon, no el recomendado.
  if (/median[oa]/i.test(etiqueta)) return 'mediana';
  if (/antes|anterior/i.test(etiqueta)) return 'antes';
  return 'recomendado';
}

// `a-price` principal (no tachado) y su `a-offscreen`.
const PRECIO_RE =
  /<span class="a-price(?![\w-]*\s*a-text-price)(?:(?!a-text-price)[^"])*"[^>]*>\s*<span class="a-offscreen">([^<]+)</g;
const TACHADO_RE =
  /<span class="a-price a-text-price[^"]*"[^>]*data-a-strike="true"[^>]*>\s*<span class="a-offscreen">([^<]+)</g;
const UNIDAD_RE = /^\s*\/\s*(?:kg|g|100\s*g|l|100\s*ml|ml|unidad|ud|lavado|metro|m)\b/i;

function resultadoBusqueda(bloque: string, asin: string): ItemListado {
  const t =
    /<h2[^>]*aria-label="([^"]+)"/.exec(bloque)?.[1] ??
    /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(bloque)?.[1] ??
    '';
  const titulo = textoPlano(t).replace(/^Anuncio patrocinado: /i, '');
  const precios = [...bloque.matchAll(PRECIO_RE)];
  const primero = precios[0];
  let cents: number | null = null;
  let porUnidad = false;
  let desde = false;
  let refCents: number | null = null;
  let refTipo: RefTipo | null = null;
  if (primero?.index !== undefined) {
    cents = euros(primero[1]);
    const antes = textoPlano(bloque.slice(Math.max(0, primero.index - 400), primero.index));
    const despues = textoPlano(bloque.slice(primero.index, primero.index + 600));
    desde = /(?:opciones de compra|ofertas? de productos|desde)\s*$/i.test(antes);
    // «8,79 € (8,79 €/unidad)»: el primero es el precio; si lo que sigue al primer importe
    // es «/kg», el visible es un precio por unidad.
    porUnidad = UNIDAD_RE.test(despues.replace(/^[^€]*€/, ''));
    // El tachado tiene que ir antes de cualquier otro precio principal (otro producto).
    const fin = precios[1]?.index ?? bloque.length;
    TACHADO_RE.lastIndex = primero.index;
    const tachado = TACHADO_RE.exec(bloque);
    if (
      tachado?.index !== undefined &&
      tachado.index < fin &&
      tachado.index - primero.index < 2500
    ) {
      refCents = euros(tachado[1]);
      refTipo = refTipoDe(
        textoPlano(bloque.slice(Math.max(0, tachado.index - 200), tachado.index)),
      );
    }
  }
  return {
    asin,
    titulo,
    cents,
    refCents,
    refTipo,
    patrocinado: /Patrocinado|AdHolder|sp-sponsored/i.test(bloque.slice(0, 6000)),
    desde,
    porUnidad,
  };
}

function resultadoRejilla(bloque: string): ItemListado | null {
  const asin =
    /<div id="([A-Z0-9]{10})"/.exec(bloque)?.[1] ?? /data-asin="([A-Z0-9]{10})"/.exec(bloque)?.[1];
  if (!asin) return null;
  const enlaces = [
    ...bloque.matchAll(/<a [^>]*href="[^"]*\/dp\/[A-Z0-9]{10}[^"]*"[^>]*>([\s\S]*?)<\/a>/g),
  ];
  const titulo =
    enlaces
      .map((m) => textoPlano(m[1] ?? ''))
      .find((x) => x.length > 8 && !/€|estrellas/.test(x)) ?? '';
  const p = /p13n-sc-price[^"]*"[^>]*>([^<]+)</.exec(bloque)?.[1];
  // «desde» en la rejilla: «2 ofertas desde 30,00 €» (no hay oferta principal).
  const desde = /ofertas? desde|opciones de compra/i.test(textoPlano(bloque));
  return {
    asin,
    titulo,
    cents: euros(p),
    refCents: null,
    refTipo: null,
    patrocinado: false,
    desde,
    porUnidad: false,
  };
}

/** Cada trozo va de una marca a la siguiente; con el primer grupo capturado. */
function trozos(html: string, marca: RegExp): [string, string][] {
  const ms = [...html.matchAll(marca)];
  return ms.map((m, i) => [html.slice(m.index, ms[i + 1]?.index ?? html.length), m[1] ?? '']);
}

/** Resultados de un listado de Amazon.es (búsqueda o rejilla de «más vendidos»). */
export function parseListado(html: string): ItemListado[] {
  const out: ItemListado[] = [];
  const vistos = new Set<string>();
  const add = (it: ItemListado | null) => {
    if (!it || vistos.has(it.asin)) return;
    vistos.add(it.asin);
    out.push(it);
  };
  // `role` y `data-asin` en cualquier orden (la página real y la recortada en el navegador).
  const busqueda = trozos(
    html,
    /<div (?=[^>]*role="listitem")[^>]*data-asin="([A-Z0-9]{10})"[^>]*>/g,
  );
  if (busqueda.length) {
    for (const [b, asin] of busqueda) add(resultadoBusqueda(b, asin));
    return out;
  }
  for (const [b] of trozos(html, /<div id="gridItemRoot"/g)) add(resultadoRejilla(b));
  if (!out.length) for (const it of parseOfertas(html)) add(it);
  return out;
}

/** El objeto JSON que empieza en `i` (llaves y cadenas con escapes), o null. */
function objetoJson(s: string, i: number): unknown {
  if (s[i] !== '{') return null;
  let prof = 0;
  let enCadena = false;
  for (let j = i; j < s.length && j < i + 2_000_000; j++) {
    const c = s[j];
    if (enCadena) {
      if (c === '\\') j++;
      else if (c === '"') enCadena = false;
    } else if (c === '"') enCadena = true;
    else if (c === '{') prof++;
    else if (c === '}' && --prof === 0) {
      try {
        return JSON.parse(s.slice(i, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface ProductoOferta {
  asin?: unknown;
  title?: unknown;
  buyingOptionType?: unknown;
  price?: {
    priceToPay?: { price?: unknown };
    basisPrice?: { label?: unknown; price?: unknown };
  };
}

const centsDe = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/**
 * «Ofertas» (amazon.es/deals, «Ofertas del día»): la página real (6-nov-2026, en un navegador)
 * no trae los productos en HTML sino en un JSON incrustado `productSearchResponse.products`,
 * con `priceToPay` y `basisPrice` («Recomendado:», «Mediano:» o «Más bajo:»).
 */
export function parseOfertas(html: string): ItemListado[] {
  const at = html.indexOf('"productSearchResponse":');
  if (at < 0) return [];
  const r = objetoJson(html, html.indexOf('{', at)) as { products?: ProductoOferta[] } | null;
  const out: ItemListado[] = [];
  for (const p of r?.products ?? []) {
    if (typeof p.asin !== 'string' || !/^[A-Z0-9]{10}$/.test(p.asin)) continue;
    if (p.buyingOptionType !== undefined && p.buyingOptionType !== 'NEW') continue;
    const base = p.price?.basisPrice;
    const refCents = centsDe(base?.price);
    out.push({
      asin: p.asin,
      titulo: typeof p.title === 'string' ? p.title : '',
      cents: centsDe(p.price?.priceToPay?.price),
      refCents,
      refTipo: refCents ? refTipoDe(typeof base?.label === 'string' ? base.label : '') : null,
      patrocinado: false,
      desde: false,
      porUnidad: false,
    });
  }
  return out;
}

const BLOQUE_PRECIO =
  /id="(?:corePriceDisplay_desktop_feature_div|corePrice_feature_div|apex_desktop)"/;

/** La ficha de un producto: precio de la oferta principal, tachado, stock, vendedor y estado. */
export function parseFicha(html: string): Ficha {
  const titulo = textoPlano(
    /<span id="productTitle"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? '',
  );
  const at = html.search(BLOQUE_PRECIO);
  const bloque = at >= 0 ? html.slice(at, at + 12_000) : '';
  const oculto =
    /añádelo a la cesta|a[ñn]adir a la cesta para ver el precio|ver los detalles del producto, a/i.test(
      textoPlano(bloque.slice(0, 3000)),
    );
  let cents: number | null = null;
  let refCents: number | null = null;
  let refTipo: RefTipo | null = null;
  const pagar =
    /apex-pricetopay-value/.exec(bloque) ??
    /priceToPay/.exec(bloque) ??
    /<span class="a-price[^"]*"/.exec(bloque);
  if (pagar?.index !== undefined && !oculto) {
    cents = importe(bloque.slice(pagar.index, pagar.index + 600));
    const tras = bloque.slice(pagar.index, pagar.index + 3000);
    const base = /apex-basisprice-value|data-a-strike="true"/.exec(tras);
    // El tachado de la ficha es el de la oferta principal solo si no hay otro precio a pagar
    // entre medias (las variantes del «twister» traen el suyo).
    const otro = tras.slice(40).search(/apex-pricetopay-value|priceToPay/);
    if (base?.index !== undefined && (otro < 0 || base.index < otro + 40)) {
      refCents = importe(tras.slice(base.index, base.index + 600));
      refTipo = refTipoDe(textoPlano(tras.slice(Math.max(0, base.index - 250), base.index)));
    }
  }
  // En el navegador hay dos bloques de precio: la caja de compra (corePrice_feature_div, sale
  // primero y sin tachado) y la columna central (corePriceDisplay_desktop_feature_div /
  // apex_desktop) con «El precio más bajo de los últimos 30 días». El tachado se toma de esta
  // última si su precio es el mismo (6-nov-2026, 10 de 10 fichas reales).
  if (cents !== null && refCents === null) {
    const c = html.search(/id="(?:corePriceDisplay_desktop_feature_div|apex_desktop)"/);
    const centro = c >= 0 && c !== at ? html.slice(c, c + 12_000) : '';
    const p = /apex-pricetopay-value/.exec(centro) ?? /priceToPay/.exec(centro);
    if (p?.index !== undefined && importe(centro.slice(p.index, p.index + 600)) === cents) {
      const tras = centro.slice(p.index, p.index + 3000);
      const base = /apex-basisprice-value|data-a-strike="true"/.exec(tras);
      const otro = tras.slice(40).search(/apex-pricetopay-value|priceToPay/);
      if (base?.index !== undefined && (otro < 0 || base.index < otro + 40)) {
        refCents = importe(tras.slice(base.index, base.index + 600));
        refTipo = refTipoDe(textoPlano(tras.slice(Math.max(0, base.index - 250), base.index)));
      }
    }
  }
  const disp = textoPlano(/id="availability"[^>]*>([\s\S]{0,800})/.exec(html)?.[1] ?? '').slice(
    0,
    160,
  );
  const enStock = /no disponible|agotado|sin stock/i.test(disp)
    ? false
    : /en stock|disponible|quedan|recíbelo|envío/i.test(disp)
      ? true
      : // Ofertas flash: sin texto de disponibilidad, pero con el botón «Añadir a la cesta».
        /id="add-to-cart-button"/.test(html)
        ? true
        : null;
  // El vendedor se lee junto a la caja de compra: en el navegador la ficha pesa 2–3 MB y ese
  // bloque cae a 330–510 KB (6-nov-2026); cortar en 400 KB lo perdía o lo partía a medias.
  const caja = html.search(
    /fulfillerInfoFeature_feature_div|offer-display-feature-name="desktop-(?:fulfiller|merchant)-info|id="merchant-info"/,
  );
  const plano = textoPlano(caja >= 0 ? html.slice(Math.max(0, caja - 2000), caja + 12_000) : html);
  // «Remitente / Vendedor Amazon» (envía y vende el mismo) o «Envío desde: X Vendido por: Y».
  // «Remitente / Vendedor Productos Profesionales AMP Productos Profesionales AMP …»: el nombre entero, una vez.
  const ambos =
    /Remitente \/ Vendedor:?\s+(.{1,60}?)(?=\s+(?:Remitente|Devoluciones|Pol[ií]ticas|Pago|Embalaje|Detalles|Ver)\b|\s*$|\.)/
      .exec(plano)?.[1]
      ?.trim()
      .replace(/^(.+?) \1$/, '$1') ?? null;
  // La ficha real repite el nombre: «Vendido por RUIMEN RUIMEN Vendido por RUIMEN Devoluciones».
  const vendedor =
    ambos ??
    /Vendido por:?\s+(.{1,40}?)(?=\s+(?:Segunda|Devoluciones|Pol[ií]ticas|Pago|Envío|Embalaje|Detalles|Ver|Vendido)\b|\s*$|\.)/i
      .exec(plano)?.[1]
      ?.trim()
      .replace(/^(.+?) \1$/, '$1') ??
    null;
  const envio = ambos ?? /Envío desde:?\s+(\S+)/i.exec(plano)?.[1] ?? null;
  const estadoTxt = `${titulo} ${textoPlano(bloque.slice(0, 4000))}`;
  const estado = /reacondicionado|renewed|renovado/i.test(estadoTxt)
    ? 'reacondicionado'
    : /segunda mano|usado - |como nuevo/i.test(estadoTxt)
      ? 'segunda mano'
      : 'nuevo';
  return {
    titulo,
    marca: marcaFicha(html),
    cents,
    precioOculto: oculto || cents === null,
    refCents,
    refTipo,
    enStock,
    vendedor,
    envio,
    estado,
  };
}

/** «Marca» de la tabla de la ficha (po-brand) o el enlace de marca bajo el título (bylineInfo). */
export function marcaFicha(html: string): string | null {
  const po =
    /class="a-spacing-small po-brand"[\s\S]{0,600}?<td class="a-span9"[^>]*>\s*<span[^>]*>([^<]*)</.exec(
      html,
    );
  if (po) return textoPlano(po[1] ?? '');
  const by = /id="bylineInfo"[^>]*>([^<]*)</.exec(html)?.[1];
  if (by === undefined) return null;
  const t = textoPlano(by);
  const m = /^(?:Visita la tienda de|Marca:)\s*(.*)$/i.exec(t);
  return m ? (m[1] ?? '').trim() : t ? t : null;
}

export function urlFicha(asin: string): string {
  return `${AMAZON_ORIGIN}/dp/${asin}`;
}
