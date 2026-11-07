/**
 * Fuentes públicas de chollos (RSS de webs de ofertas, canales públicos de Telegram en
 * t.me/s/<canal>) como PISTAS: dicen dónde mirar, nunca deciden. Cada pista se convierte en una
 * búsqueda de amazon.es que pasa por el listado, la ficha y un histórico real (el propio o
 * camelcamelcamel), igual que cualquier otro candidato.
 *
 * Por qué (7-nov-2026): la dashcam «RexingUSA V1-4K» (B0BSJZPSJP, nº29.026 en Electrónica, de
 * 2023) bajó a 19,73 € (~170 € esa semana) y la publicaron las cuentas de chollos; no estaba en
 * ninguna página de las que barremos. Un producto de cola larga solo aparece así.
 */

import { AMAZON_ORIGIN } from './amazon.js';

export interface Pista {
  /** Identificador estable para no repetirla (guid/enlace del chollo o del mensaje). */
  id: string;
  titulo: string;
  asin: string | null;
}

/** Por defecto: el RSS público de Chollometro (solo los de Amazon). `PA_PRECIOS_FUENTES`. */
export const FUENTES_POR_DEFECTO = ['https://www.chollometro.com/rss'];

/** `PA_PRECIOS_FUENTES`: vacío = las de por defecto; «no» = ninguna; si no, URLs https por comas. */
export function fuentesDesde(valor: string | undefined): string[] {
  const v = (valor ?? '').trim();
  if (/^(no|0|off|ninguna)$/i.test(v)) return [];
  if (!v) return FUENTES_POR_DEFECTO;
  return v
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^https:\/\//.test(p));
}

const ENTIDADES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function texto(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#')
        return String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        );
      return ENTIDADES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** ASIN de un enlace de amazon.es (/dp/…, /gp/product/…), también dentro de un enlace codificado. */
export function asinDe(s: string): string | null {
  const d = s.replace(/%2F/gi, '/');
  const m =
    /amazon\.es\/(?:[^\s"'<>?#]*\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?![A-Z0-9])/.exec(
      d,
    );
  return m ? (m[1] as string) : null;
}

const ES_AMAZON = /\bamazon(?:\.es)?\b/i;

function etiqueta(xml: string, nombre: string): string {
  const m = new RegExp(`<${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</${nombre}>`, 'i').exec(xml);
  return m ? (m[1] as string) : '';
}

/** RSS 2.0 (Chollometro y similares): solo las ofertas de Amazon. */
function pistasRss(xml: string): Pista[] {
  const out: Pista[] = [];
  for (const bloque of xml.split(/<item[\s>]/i).slice(1)) {
    const item = bloque.split(/<\/item>/i)[0] ?? '';
    const titulo = texto(etiqueta(item, 'title'));
    const enlace = texto(etiqueta(item, 'link'));
    const id = texto(etiqueta(item, 'guid')) || enlace || titulo;
    const tienda = /<pepper:merchant\b[^>]*\bname="([^"]*)"/i.exec(item)?.[1] ?? '';
    const asin = asinDe(item);
    const deAmazon = asin !== null || ES_AMAZON.test(tienda) || /amazon\.es/i.test(enlace);
    if (!titulo || !deAmazon) continue;
    out.push({ id, titulo, asin });
  }
  return out;
}

/** Canal público de Telegram (t.me/s/<canal>): mensajes que enlazan a amazon.es o la nombran. */
function pistasTelegram(html: string): Pista[] {
  const out: Pista[] = [];
  const partes = html.split(/data-post="/).slice(1);
  for (const p of partes) {
    const id = `tg:${p.slice(0, p.indexOf('"'))}`;
    const cuerpo = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(p)?.[1] ?? '';
    if (!cuerpo) continue;
    const asin = asinDe(cuerpo);
    const plano = texto(cuerpo);
    if (!asin && !ES_AMAZON.test(plano)) continue;
    const negrita = /<b>([^<]{8,})<\/b>/.exec(cuerpo)?.[1];
    const titulo = texto(negrita ?? plano).slice(0, 160);
    if (titulo) out.push({ id, titulo, asin });
  }
  return out;
}

/** Pistas de una fuente (RSS o página pública de Telegram). Lo que no entiende, nada. */
export function parseFuente(contenido: string): Pista[] {
  if (/<rss[\s>]|<channel[\s>]/i.test(contenido)) return pistasRss(contenido);
  if (/tgme_widget_message/.test(contenido)) return pistasTelegram(contenido);
  return [];
}

// Lo que no ayuda a encontrar el producto: precio, «error de precio», emojis, etiquetas.
const RUIDO =
  /(\d+[.,]?\d*\s*(?:€|eur\b))|\b(?:error(?:es)? de precio|chollo|oferta|antes|ahora|por solo|solo|a solo|precio m[ií]nimo|m[ií]nimo hist[oó]rico|cup[oó]n)\b|#\S+|[^\p{L}\p{N}\s.,+\-/]/giu;

/** Búsqueda de amazon.es para una pista: por ASIN si lo trae; si no, por las primeras palabras. */
export function urlPista(p: Pista): string {
  const k =
    p.asin ?? p.titulo.replace(RUIDO, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return `${AMAZON_ORIGIN}/s?${new URLSearchParams({ k }).toString()}`;
}
