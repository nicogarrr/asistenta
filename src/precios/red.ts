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

/** Navegador primero; si no hay (Chrome cerrado, sin permiso), la petición normal. */
export function conRespaldo(
  primero: (url: string) => Promise<Respuesta>,
  respaldo: (url: string) => Promise<Respuesta>,
) {
  return async (url: string): Promise<Respuesta> => {
    try {
      return await primero(url);
    } catch {
      return respaldo(url);
    }
  };
}

export interface ConfigPrecios {
  activo: boolean;
  motivoApagado?: string;
  cadaMin: number;
  ratio: number;
  paginas: number;
  categorias: string | undefined;
}

/**
 * .env: PA_PRECIOS=0 lo apaga (encendido por defecto); PA_PRECIOS_UMBRAL=70 (descuento mínimo,
 * %); PA_PRECIOS_CADA_MIN=30; PA_PRECIOS_PAGINAS=6 (listados por barrido);
 * PA_PRECIOS_CATEGORIAS=cocina,informatica,… (vacío = todas).
 */
export function configPrecios(env: NodeJS.ProcessEnv = process.env): ConfigPrecios {
  const off = /^(0|no|off|false|apagado)$/i.test((env.PA_PRECIOS ?? '').trim());
  const num = (v: string | undefined, def: number, min: number, max: number) => {
    const n = Number.parseFloat((v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const descuento = num(env.PA_PRECIOS_UMBRAL, 70, 30, 95);
  return {
    activo: !off,
    motivoApagado: off ? 'PA_PRECIOS=0 en el .env' : undefined,
    cadaMin: Math.round(num(env.PA_PRECIOS_CADA_MIN, 30, 15, 24 * 60)),
    ratio: Math.round((1 - descuento / 100) * 100) / 100,
    paginas: Math.round(num(env.PA_PRECIOS_PAGINAS, 6, 1, 20)),
    categorias: env.PA_PRECIOS_CATEGORIAS,
  };
}
