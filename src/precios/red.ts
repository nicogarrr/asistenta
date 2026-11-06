/**
 * Cómo lee Asistenta las páginas de Amazon.es para el vigilante de errores de precio.
 *
 * - Listados: petición HTTP normal con cabeceras de un Chrome en español. Los listados traen
 *   el precio aunque se pidan así (comprobado el 6-nov-2026).
 * - Fichas: Amazon ESCONDE el precio a quien no es un navegador real («Para ver los detalles
 *   del producto, añádelo a la cesta»), y esa era la razón de que Amazon «fallara». Por eso la
 *   ficha se abre en el Chrome de Asistenta (el del dueño, con su sesión y su dirección), se
 *   recorta dentro de la página a lo que importa y se lee aquí con `parseFicha`.
 */

import { SIN_MARCA_POR_DEFECTO } from './regla.js';
import type { Respuesta } from './vigilante.js';

export const CABECERAS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
};

export function leerHttp(f: typeof fetch = fetch, timeoutMs = 20_000) {
  return async (url: string): Promise<Respuesta> => {
    if (!/^https:\/\/www\.amazon\.es\//.test(url)) throw new Error('solo leo páginas de amazon.es');
    const r = await f(url, {
      headers: CABECERAS,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = (await r.text()).slice(0, 4_000_000);
    return { status: r.status, html };
  };
}

/** Lo mínimo del navegador (BrowserService lo cumple). */
export interface NavegadorPrecios {
  execJs(scope: string, code: string): Promise<{ text: string }>;
}

const TROZO = 7000;

/** Código que corre en la pestaña: abre la ficha y deja en `state` un HTML recortado. */
export function codigoFicha(url: string): string {
  return [
    `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });`,
    'await page.waitForTimeout(2500);',
    'const html = await page.evaluate(() => {',
    '  const q = (s) => document.querySelector(s);',
    "  const texto = (document.body && document.body.innerText) || '';",
    '  if (q(\'form[action*="validateCaptcha"]\') || /Introduce los caracteres|Escribe los caracteres/.test(texto)) {',
    '    return \'<form action="/errors/validateCaptcha"></form>\';',
    '  }',
    '  const limpia = (el, max) => {',
    "    if (!el) return '';",
    '    const c = el.cloneNode(true);',
    "    for (const n of c.querySelectorAll('script,style,svg,img,noscript,iframe')) n.remove();",
    "    for (const n of [c, ...c.querySelectorAll('*')]) {",
    "      for (const a of [...n.attributes]) if (!['id', 'class', 'data-a-strike'].includes(a.name)) n.removeAttribute(a.name);",
    '    }',
    "    return c.outerHTML.replace(/\\s+/g, ' ').slice(0, max);",
    '  };',
    "  const precio = q('#corePriceDisplay_desktop_feature_div') || q('#corePrice_feature_div') || q('#apex_desktop');",
    "  const vende = q('#merchantInfoFeature_feature_div') || q('#tabular-buybox') || q('#shipsFromSoldBy_feature_div');",
    "  const vendeTxt = vende ? vende.innerText.replace(/\\s+/g, ' ').slice(0, 600) : '';",
    "  return '<html><body>' + limpia(q('#productTitle'), 2000) + limpia(precio, 20000) + limpia(q('#availability'), 1500) + '<div>' + vendeTxt + '</div></body></html>';",
    '});',
    'state.preciosFicha = html;',
    'return String(html.length);',
  ].join('\n');
}

/** Código que corre en la pestaña: abre un listado y deja en `state` sus resultados recortados. */
export function codigoListado(url: string): string {
  return [
    `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });`,
    'await page.waitForTimeout(2000);',
    'const html = await page.evaluate(() => {',
    "  const texto = (document.body && document.body.innerText) || '';",
    '  if (document.querySelector(\'form[action*="validateCaptcha"]\') || /Introduce los caracteres|Escribe los caracteres/.test(texto)) {',
    '    return \'<form action="/errors/validateCaptcha"></form>\';',
    '  }',
    "  const deja = ['id', 'class', 'role', 'data-asin', 'data-a-strike', 'aria-label', 'href'];",
    '  const limpia = (el) => {',
    '    const c = el.cloneNode(true);',
    "    for (const n of c.querySelectorAll('script,style,svg,img,noscript,iframe')) n.remove();",
    "    for (const n of [c, ...c.querySelectorAll('*')]) {",
    '      for (const a of [...n.attributes]) {',
    "        if (!deja.includes(a.name) || (a.name === 'href' && !/\\/dp\\//.test(a.value))) n.removeAttribute(a.name);",
    '      }',
    '    }',
    "    return c.outerHTML.replace(/\\s+/g, ' ').slice(0, 3000);",
    '  };',
    '  const items = [...document.querySelectorAll(\'div[role="listitem"][data-asin], #gridItemRoot, [id="gridItemRoot"]\')];',
    // «Ofertas» (/deals): los productos van en un JSON dentro de la página, no en el HTML.
    '  const raw = items.length ? -1 : document.documentElement.innerHTML.indexOf(\'"productSearchResponse":\');',
    "  if (raw >= 0) return '<html><body><script>' + document.documentElement.innerHTML.slice(raw, raw + 200000) + '</script></body></html>';",
    "  return '<html><body>' + items.slice(0, 60).map(limpia).join('') + '</body></html>';",
    '});',
    'state.preciosPagina = html;',
    'return String(html.length);',
  ].join('\n');
}

async function trozos(
  nav: NavegadorPrecios,
  scope: string,
  clave: string,
  n: number,
): Promise<string> {
  let html = '';
  for (let i = 0; i < n && i < TROZO * 30; i += TROZO) {
    html += (
      await nav.execJs(scope, `return String(state.${clave} || '').slice(${i}, ${i + TROZO});`)
    ).text;
  }
  return html;
}

/** Lee un listado en el navegador real (Amazon da menos captchas a un Chrome con su sesión). */
export function leerListadoNavegador(nav: NavegadorPrecios, scope: string) {
  return async (url: string): Promise<Respuesta> => {
    if (!/^https:\/\/www\.amazon\.es\//.test(url)) throw new Error('solo leo páginas de amazon.es');
    const r = await nav.execJs(scope, codigoListado(url));
    const n = Number(r.text);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`el navegador no pudo abrir el listado: ${r.text.slice(0, 160)}`);
    return { status: 200, html: await trozos(nav, scope, 'preciosPagina', n) };
  };
}

/** Código que corre en la pestaña: abre el histórico de camelcamelcamel y deja su tabla de precios. */
export function codigoHistorial(url: string): string {
  return [
    `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });`,
    'await page.waitForTimeout(3000);',
    'const html = await page.evaluate(() => {',
    '  const fila = document.querySelector(\'tr[data-field="amazon"], tr[data-field="new"]\');',
    "  const t = fila ? fila.closest('table') : null;",
    "  return t ? t.outerHTML.replace(/\\s+/g, ' ').slice(0, 20000) : '<html></html>';",
    '});',
    'state.preciosHistorial = html;',
    'return String(html.length);',
  ].join('\n');
}

/** Histórico externo de un candidato (camelcamelcamel) en el navegador real. */
export function leerHistorialNavegador(nav: NavegadorPrecios, scope: string) {
  return async (url: string): Promise<Respuesta> => {
    if (!/^https:\/\/es\.camelcamelcamel\.com\/product\/[A-Z0-9]{10}$/.test(url))
      throw new Error('histórico no válido');
    const r = await nav.execJs(scope, codigoHistorial(url));
    const n = Number(r.text);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`el navegador no pudo abrir el histórico`);
    return { status: 200, html: await trozos(nav, scope, 'preciosHistorial', n) };
  };
}

/** Lee la ficha en el navegador real; el HTML recortado vuelve en trozos (el canal corta a 8000). */
export function leerFichaNavegador(nav: NavegadorPrecios, scope: string) {
  return async (url: string): Promise<Respuesta> => {
    if (!/^https:\/\/www\.amazon\.es\/dp\/[A-Z0-9]{10}$/.test(url))
      throw new Error('ficha de amazon.es no válida');
    const r = await nav.execJs(scope, codigoFicha(url));
    const n = Number(r.text);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`el navegador no pudo abrir la ficha: ${r.text.slice(0, 160)}`);
    let html = '';
    for (let i = 0; i < n && i < TROZO * 6; i += TROZO) {
      html += (
        await nav.execJs(
          scope,
          `return String(state.preciosFicha || '').slice(${i}, ${i + TROZO});`,
        )
      ).text;
    }
    return { status: 200, html };
  };
}

export interface Respaldo {
  (url: string): Promise<Respuesta>;
  /** Por qué no se usó el navegador la última vez (null si funcionó). */
  fallo(): { at: number; motivo: string } | null;
}

/**
 * Navegador primero; si falla (Chrome cerrado, sin permiso para amazon.es), la petición
 * normal, y el navegador no se vuelve a intentar en `pausaMs` (así no se acumulan preguntas
 * de «¿Abro amazon.es?» si nadie contesta).
 */
export function conRespaldo(
  primero: (url: string) => Promise<Respuesta>,
  respaldo: (url: string) => Promise<Respuesta>,
  o: { pausaMs?: number; now?: () => number } = {},
): Respaldo {
  let ultimo: { at: number; motivo: string } | null = null;
  const now = o.now ?? Date.now;
  const leer = async (url: string): Promise<Respuesta> => {
    if (ultimo && now() - ultimo.at < (o.pausaMs ?? 6 * 3600_000)) return respaldo(url);
    try {
      const r = await primero(url);
      ultimo = null;
      return r;
    } catch (err) {
      ultimo = { at: now(), motivo: err instanceof Error ? err.message : String(err) };
      return respaldo(url);
    }
  };
  return Object.assign(leer, { fallo: () => ultimo });
}

export interface ConfigPrecios {
  activo: boolean;
  /** Línea diaria «Precios hoy: …» a las 21:00 (PA_PRECIOS_RESUMEN_DIARIO, encendido por defecto). */
  resumenDiario: boolean;
  motivoApagado?: string;
  cadaMin: number;
  ratio: number;
  paginas: number;
  categorias: string | undefined;
  /** Minutos entre barridos rápidos de las búsquedas caras (0 = sin barrido rápido). */
  rapidoMin: number;
  paginasRapido: number;
  rapidas: string | undefined;
  /** Marcas que cuentan como «sin marca» (las de por defecto + `PA_PRECIOS_SIN_MARCA`). */
  sinMarca: string[];
}

/**
 * .env: PA_PRECIOS=0 lo apaga (encendido por defecto); PA_PRECIOS_UMBRAL=60 (descuento mínimo frente a un histórico real,
 * %); PA_PRECIOS_CADA_MIN=30; PA_PRECIOS_PAGINAS=6 (listados por barrido);
 * PA_PRECIOS_CATEGORIAS=cocina,informatica,… (vacío = todas); PA_PRECIOS_RAPIDO_MIN=12 (búsquedas
 * caras: ghd, Dyson, whisky…; 0 = no), PA_PRECIOS_RAPIDO_PAGINAS=4, PA_PRECIOS_RAPIDAS=ghd,chivas…
 * PA_PRECIOS_SIN_MARCA=deertime,pinglang (marcas que se tratan como «sin marca», además de
 * Genérico, Generic, Sin marca…).
 */
export function configPrecios(env: NodeJS.ProcessEnv = process.env): ConfigPrecios {
  const off = /^(0|no|off|false|apagado)$/i.test((env.PA_PRECIOS ?? '').trim());
  const num = (v: string | undefined, def: number, min: number, max: number) => {
    const n = Number.parseFloat((v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const descuento = num(env.PA_PRECIOS_UMBRAL, 60, 30, 95);
  return {
    activo: !off,
    resumenDiario: !/^(0|no|off|false|apagado)$/i.test(
      (env.PA_PRECIOS_RESUMEN_DIARIO ?? '').trim(),
    ),
    motivoApagado: off ? 'PA_PRECIOS=0 en el .env' : undefined,
    cadaMin: Math.round(num(env.PA_PRECIOS_CADA_MIN, 30, 15, 24 * 60)),
    ratio: Math.round((1 - descuento / 100) * 100) / 100,
    paginas: Math.round(num(env.PA_PRECIOS_PAGINAS, 6, 1, 20)),
    categorias: env.PA_PRECIOS_CATEGORIAS,
    rapidoMin: (() => {
      const m = num(env.PA_PRECIOS_RAPIDO_MIN, 12, 0, 24 * 60);
      return m <= 0 ? 0 : Math.max(5, Math.round(m));
    })(),
    paginasRapido: Math.round(num(env.PA_PRECIOS_RAPIDO_PAGINAS, 4, 1, 10)),
    rapidas: env.PA_PRECIOS_RAPIDAS,
    sinMarca: [
      ...SIN_MARCA_POR_DEFECTO,
      ...(env.PA_PRECIOS_SIN_MARCA ?? '')
        .split(',')
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean),
    ],
  };
}
