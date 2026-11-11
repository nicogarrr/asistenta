/**
 * «📖 Al Kindle» (Nico, 11 nov 2026: «generar el PDF y si se puede con Calibre convertir a
 * formato Kindle Paperwhite 11ª generación… para que cuando eso llegue me lo pase para
 * leerlo»). De una cosa de la bandeja que se lee (artículo, PDF, post o hilo de X, y la
 * transcripción de un vídeo o podcast) sale un EPUB limpio (y un PDF si lo pide), con
 * una primera página con título, autor, fecha y enlace de origen; con Calibre en el PC,
 * además el AZW3 del Paperwhite (`--output-profile kindle_pw3`) para pasarlo por USB.
 *
 * Reglas:
 * - Solo para Nico: el fichero va a su chat y, si lo activó, a SU dirección @kindle.com
 *   (PA_KINDLE_EMAIL o «/bandeja kindle correo …»). Nunca se publica en ningún sitio.
 * - Un PDF original va tal cual, sin rehacerlo.
 * - Muro de pago o página que pide sesión: no se salta; va el enlace y el porqué.
 * - Calibre no se instala solo: sin él se queda en EPUB y se dice una vez cómo ponerlo.
 */
import { createHash } from 'node:crypto';
import { type Azw3Result, epubToAzw3 } from '../books/convert.js';
import { isKindleAddress, safeFilename } from '../books/kindle.js';
import { localDay } from '../datecontext.js';
import { crearPdf } from '../entregables/pdf.js';
import { xml, zip } from '../entregables/xlsx.js';
import type { MailAccount, SendRequest, SendResult } from '../mail/types.js';
import { sliceSafe } from '../text.js';
import { decodeEntities, extractText } from '../tools/fetch.js';
import { canonicalKey, displayUrl, kindOfUrl } from './captura.js';
import type { FetchRaw } from './goodreads.js';
import { readableDocKind } from './procesar.js';
import type { BandejaExtra, BandejaItem, BandejaStore } from './store.js';

export type BlockKind = 'h' | 'p' | 'li' | 'q';
export interface Block {
  t: BlockKind;
  text: string;
}

/** Lo que va al libro: los datos de la primera página y el texto en bloques. */
export interface KindleDoc {
  title: string;
  author?: string;
  /** Fecha de publicación (AAAA-MM-DD si se pudo leer). */
  date?: string;
  /** Sitio o fuente legible («elconfidencial.com», «YouTube», «X»). */
  source?: string;
  url?: string;
  lang?: string;
  /** Qué es el texto («Transcripción del vídeo», «Post de X»), si no es el artículo. */
  note?: string;
  blocks: Block[];
}

/** Por debajo de esto una página no es un artículo (portada, muro de pago, «inicia sesión»). */
export const MIN_ARTICLE_WORDS = 150;
/** Un trozo de XHTML por parte: el Kindle va lento con ficheros enormes. */
const PART_CHARS = 120_000;
/** Telegram no deja mandar más de 50 MB por bot. */
const MAX_SEND_BYTES = 50_000_000;
/**
 * Lo que cabe en un correo al Kindle. Amazon acepta hasta 50 MB, pero el adjunto viaja en
 * base64 (un tercio más) y Gmail/Outlook cortan en 20–25 MB por mensaje: un PDF de 19 MB
 * llegaba a «El correo al Kindle falló (552 …)» tras subirlo entero.
 */
export const KINDLE_MAIL_MAX_BYTES = 18_000_000;

// ─── Texto → bloques ────────────────────────────────────────────────────────────

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Un párrafo larguísimo (una transcripción sin puntos y aparte) en párrafos de lectura. */
function splitLong(text: string, max = 900): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["»”)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
    // Una «frase» sin puntos de miles de caracteres: se corta por palabras.
    while (cur.length > max * 2) {
      const cut = cur.lastIndexOf(' ', max) > 0 ? cur.lastIndexOf(' ', max) : max;
      out.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Texto plano (una transcripción, un post, lo guardado) en bloques. */
export function textBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r/g, '').split(/\n+/)) {
    const line = clean(raw);
    if (!line) continue;
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h?.[1]) {
      out.push({ t: 'h', text: h[1] });
      continue;
    }
    const li = /^[-•*]\s+(.+)$/.exec(line);
    if (li?.[1]) {
      out.push({ t: 'li', text: li[1] });
      continue;
    }
    for (const p of splitLong(line)) out.push({ t: 'p', text: p });
  }
  return out;
}

/**
 * Una transcripción (subtítulos, una línea corta por rótulo; o trozos «[12:30] …» del
 * audio) en párrafos de lectura: sin marcas de tiempo, las líneas cosidas y vueltas a
 * partir por frases.
 */
export function transcriptBlocks(text: string): Block[] {
  const flowing = text
    .replace(/\r/g, '')
    .replace(/^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/gm, '')
    .split(/\n+/)
    .map(clean)
    .filter(Boolean)
    .join(' ');
  return splitLong(clean(flowing)).map((p) => ({ t: 'p' as const, text: p }));
}

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'button',
  'form',
  'nav',
  'aside',
  'footer',
  'iframe',
  'template',
  'canvas',
  'select',
  'input',
]);
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'tr',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

interface DomNode {
  nodeType: number;
  tagName?: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

function hasBlockChild(el: DomNode): boolean {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType !== 1) continue;
    const tag = (c.tagName ?? '').toLowerCase();
    if (BLOCK_TAGS.has(tag) || hasBlockChild(c)) return true;
  }
  return false;
}

function walk(el: DomNode, out: Block[]): void {
  let loose = '';
  const flush = (): void => {
    const t = clean(loose);
    if (t) for (const p of splitLong(t)) out.push({ t: 'p', text: p });
    loose = '';
  };
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      loose += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = (node.tagName ?? '').toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;
    if (!BLOCK_TAGS.has(tag) && !hasBlockChild(node)) {
      // En línea (a, em, strong, span…): sigue el párrafo suelto.
      loose += node.textContent ?? '';
      continue;
    }
    flush();
    const text = clean(node.textContent ?? '');
    if (/^h[1-6]$/.test(tag)) {
      if (text) out.push({ t: 'h', text });
    } else if (tag === 'li' && !hasBlockChild(node)) {
      if (text) out.push({ t: 'li', text });
    } else if (tag === 'blockquote' && !hasBlockChild(node)) {
      if (text) out.push({ t: 'q', text });
    } else if ((tag === 'p' || tag === 'pre') && !hasBlockChild(node)) {
      for (const p of splitLong(text)) if (p) out.push({ t: 'p', text: p });
    } else {
      walk(node, out);
    }
  }
  flush();
}

/** El HTML de lectura (Readability) en bloques: títulos, párrafos, listas y citas; sin imágenes. */
export async function htmlBlocks(html: string): Promise<Block[]> {
  try {
    const { parseHTML } = await import('linkedom');
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const out: Block[] = [];
    walk(document.body as unknown as DomNode, out);
    if (out.length) return out;
  } catch {
    // Sin parser: el texto plano de siempre.
  }
  return textBlocks(await extractText(html, 'text'));
}

function wordCount(blocks: readonly Block[]): number {
  return blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
}

// ─── La página: texto entero, metadatos y muro de pago ─────────────────────────

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${prop}["']`,
    'i',
  );
  const m = re.exec(html);
  const v = m?.[1] ?? m?.[2];
  return v ? decodeEntities(v).trim() || null : null;
}

/** «2026-11-10T08:00:00Z», «10 Nov 2026»… → «2026-11-10»; si no se entiende, null. */
export function isoDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? localDay(new Date(t)) : null;
}

/**
 * ¿La página es de pago o pide sesión? Lo que la propia página declara
 * (`isAccessibleForFree: false`, el marcado de Google para contenido de pago) o que el
 * texto que se lee es demasiado poco para ser el artículo. Devuelve el porqué o null.
 */
export function wallReason(html: string, words: number): string | null {
  if (/"isAccessibleForFree"\s*:\s*"?false"?/i.test(html))
    return 'la página dice que es de pago (muro de suscripción)';
  if (words < MIN_ARTICLE_WORDS)
    return 'la página trae muy poco texto (muro de pago, pide sesión o es solo una portada)';
  return null;
}

export interface ArticleRead {
  doc: KindleDoc;
  words: number;
}

/**
 * El artículo entero con Readability (ya en el proyecto, el mismo extractor que la
 * herramienta fetch), con título, autor, fecha y sitio. Lanza KindleWall si está tapado.
 */
export async function readArticle(html: string, url: string): Promise<ArticleRead> {
  let title: string | null = null;
  let author: string | null = null;
  let date: string | null = null;
  let site: string | null = null;
  let lang: string | null = null;
  let content: string | null = null;
  try {
    const [{ parseHTML }, { Readability }] = await Promise.all([
      import('linkedom'),
      import('@mozilla/readability'),
    ]);
    const { document } = parseHTML(html);
    const a = new Readability(document as unknown as Document).parse();
    if (a) {
      title = a.title ? clean(a.title) : null;
      author = a.byline ? clean(a.byline) : null;
      date = a.publishedTime ?? null;
      site = a.siteName ? clean(a.siteName) : null;
      lang = a.lang ?? null;
      content = a.content ?? null;
    }
  } catch {
    content = null;
  }
  const blocks = content ? await htmlBlocks(content) : textBlocks(await extractText(html, 'text'));
  const words = wordCount(blocks);
  const reason = wallReason(html, words);
  if (reason) throw new KindleWall(reason);
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const metaAuthor =
    metaContent(html, 'author') ??
    metaContent(html, 'article:author') ??
    metaContent(html, 'twitter:creator');
  const doc: KindleDoc = {
    title:
      title ??
      metaContent(html, 'og:title') ??
      clean(decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')) ??
      host,
    blocks,
    url,
    source: site ?? host,
  };
  const who = author ?? (metaAuthor && !/^https?:/i.test(metaAuthor) ? metaAuthor : null);
  if (who) doc.author = who;
  const day =
    isoDay(date) ??
    isoDay(metaContent(html, 'article:published_time')) ??
    isoDay(/"datePublished"\s*:\s*"([^"]+)"/.exec(html)?.[1]) ??
    isoDay(metaContent(html, 'date'));
  if (day) doc.date = day;
  const l = lang ?? /<html[^>]+lang=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
  if (l) doc.lang = l;
  if (!doc.title) doc.title = host || 'Artículo';
  return { doc, words };
}

/** Página tapada (muro de pago, sesión): se manda el enlace y el porqué, nunca se salta. */
export class KindleWall extends Error {}

// ─── EPUB ───────────────────────────────────────────────────────────────────────

/** Sin idioma declarado: español o inglés según sus palabras más comunes (el Kindle elige diccionario por esto). */
export function guessLang(blocks: readonly Block[]): 'es' | 'en' {
  const sample = blocks
    .slice(0, 60)
    .map((b) => b.text)
    .join(' ')
    .toLowerCase();
  const count = (re: RegExp) => (sample.match(re) ?? []).length;
  const es = count(/\b(el|la|los|las|que|de|en|y|es|por|para|una|con|del|se)\b/g);
  const en = count(/\b(the|and|of|to|is|that|in|for|it|with|you|this|are|on)\b/g);
  return en > es ? 'en' : 'es';
}

function safeLang(raw: string | undefined, blocks: readonly Block[]): string {
  const l = (raw ?? '').trim().replace('_', '-');
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i.test(l) ? l : guessLang(blocks);
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** «2026-11-10» → «10 de noviembre de 2026». */
export function dateLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])} de ${MONTHS[Number(m[2]) - 1] ?? m[2]} de ${m[1]}`;
}

function xhtml(title: string, lang: string, body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">`,
    `<head><meta charset="UTF-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="estilo.css"/></head>`,
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

function blockHtml(blocks: readonly Block[]): string {
  const out: string[] = [];
  let inList = false;
  for (const b of blocks) {
    if (b.t === 'li' && !inList) {
      out.push('<ul>');
      inList = true;
    } else if (b.t !== 'li' && inList) {
      out.push('</ul>');
      inList = false;
    }
    const t = xml(b.text);
    if (b.t === 'h') out.push(`<h2>${t}</h2>`);
    else if (b.t === 'li') out.push(`<li>${t}</li>`);
    else if (b.t === 'q') out.push(`<blockquote><p>${t}</p></blockquote>`);
    else out.push(`<p>${t}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

/** Las partes del texto (cada una un XHTML de como mucho ~120 000 caracteres). */
function parts(blocks: readonly Block[]): Block[][] {
  const out: Block[][] = [];
  let cur: Block[] = [];
  let size = 0;
  for (const b of blocks) {
    if (cur.length && size + b.text.length > PART_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += b.text.length;
  }
  if (cur.length || !out.length) out.push(cur);
  return out;
}

/** La primera página: título, autor, fecha, de dónde viene y el enlace. */
function titlePage(doc: KindleDoc, now: Date): string {
  const rows: string[] = [`<h1 class="titulo">${xml(doc.title)}</h1>`];
  if (doc.author) rows.push(`<p class="autor">${xml(doc.author)}</p>`);
  const facts: string[] = [];
  if (doc.date) facts.push(`<p><b>Fecha:</b> ${xml(dateLabel(doc.date))}</p>`);
  if (doc.source) facts.push(`<p><b>Fuente:</b> ${xml(doc.source)}</p>`);
  if (doc.url) facts.push(`<p class="url"><b>Enlace:</b> ${xml(doc.url)}</p>`);
  if (doc.note) facts.push(`<p><b>Qué es:</b> ${xml(doc.note)}</p>`);
  rows.push(`<div class="ficha">${facts.join('\n')}</div>`);
  rows.push(
    `<p class="pie">Copia para lectura personal, preparada por Asistenta el ${xml(dateLabel(localDay(now)))}. No es para redistribuir: los derechos son de su autor.</p>`,
  );
  return rows.join('\n');
}

const CSS = [
  'body { font-family: serif; line-height: 1.45; margin: 0 4%; }',
  'h1.titulo { font-size: 1.6em; margin: 2.5em 0 0.6em; text-align: left; }',
  'p.autor { font-size: 1.15em; font-style: italic; margin: 0 0 1.5em; }',
  'div.ficha p { margin: 0.25em 0; text-indent: 0; font-size: 0.9em; }',
  'p.url { word-wrap: break-word; overflow-wrap: break-word; }',
  'p.pie { margin-top: 3em; font-size: 0.75em; color: #555; text-indent: 0; }',
  'h2 { font-size: 1.2em; margin: 1.4em 0 0.5em; }',
  'p { margin: 0 0 0.6em; text-indent: 0; }',
  'blockquote { margin: 0.8em 1.5em; font-style: italic; }',
  'li { margin: 0.2em 0; }',
].join('\n');

/**
 * Un EPUB 3 de verdad (con navegación EPUB 3 y toc.ncx para Calibre y Kindles viejos),
 * escrito aquí sin dependencias: el zip del proyecto con el `mimetype` sin comprimir y
 * el primero, como pide el formato.
 */
export function buildEpub(doc: KindleDoc, now: Date): Buffer {
  const lang = safeLang(doc.lang, doc.blocks);
  const id = `urn:asistenta:${createHash('sha1')
    .update(doc.url ?? doc.title)
    .digest('hex')
    .slice(0, 24)}`;
  const chunks = parts(doc.blocks);
  const partName = (i: number) => `parte${i + 1}.xhtml`;
  const partLabel = (i: number) => (chunks.length > 1 ? `Texto (parte ${i + 1})` : 'Texto');
  const modified = `${now.toISOString().slice(0, 19)}Z`;
  const meta = [
    `<dc:identifier id="uid">${id}</dc:identifier>`,
    `<dc:title>${xml(doc.title)}</dc:title>`,
    `<dc:language>${lang}</dc:language>`,
    doc.author ? `<dc:creator>${xml(doc.author)}</dc:creator>` : '',
    doc.date ? `<dc:date>${xml(doc.date)}</dc:date>` : '',
    doc.source ? `<dc:publisher>${xml(doc.source)}</dc:publisher>` : '',
    doc.url ? `<dc:source>${xml(doc.url)}</dc:source>` : '',
    '<dc:rights>Copia para lectura personal; no redistribuir.</dc:rights>',
    `<meta property="dcterms:modified">${modified}</meta>`,
  ].filter(Boolean);
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="estilo.css" media-type="text/css"/>',
    '<item id="portada" href="portada.xhtml" media-type="application/xhtml+xml"/>',
    ...chunks.map(
      (_, i) => `<item id="p${i + 1}" href="${partName(i)}" media-type="application/xhtml+xml"/>`,
    ),
  ];
  const spine = [
    '<itemref idref="portada"/>',
    ...chunks.map((_, i) => `<itemref idref="p${i + 1}"/>`),
  ];
  const opf = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">`,
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n${meta.join('\n')}\n</metadata>`,
    `<manifest>\n${manifest.join('\n')}\n</manifest>`,
    `<spine toc="ncx">\n${spine.join('\n')}\n</spine>`,
    '</package>',
  ].join('\n');
  const navItems = [
    `<li><a href="portada.xhtml">${xml(doc.title)}</a></li>`,
    ...chunks.map((_, i) => `<li><a href="${partName(i)}">${xml(partLabel(i))}</a></li>`),
  ];
  const nav = xhtml(
    doc.title,
    lang,
    `<nav epub:type="toc" id="toc"><h1>Índice</h1><ol>${navItems.join('')}</ol></nav>`,
  );
  const points = [
    { label: doc.title, src: 'portada.xhtml' },
    ...chunks.map((_, i) => ({ label: partLabel(i), src: partName(i) })),
  ];
  const ncx = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
    `<head><meta name="dtb:uid" content="${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>`,
    `<docTitle><text>${xml(doc.title)}</text></docTitle>`,
    '<navMap>',
    ...points.map(
      (p, i) =>
        `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${xml(p.label)}</text></navLabel><content src="${p.src}"/></navPoint>`,
    ),
    '</navMap>',
    '</ncx>',
  ].join('\n');
  const container = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>',
    '</container>',
  ].join('\n');
  const b = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { nombre: 'mimetype', datos: b('application/epub+zip'), store: true },
    { nombre: 'META-INF/container.xml', datos: b(container) },
    { nombre: 'OEBPS/content.opf', datos: b(opf) },
    { nombre: 'OEBPS/nav.xhtml', datos: b(nav) },
    { nombre: 'OEBPS/toc.ncx', datos: b(ncx) },
    { nombre: 'OEBPS/estilo.css', datos: b(CSS) },
    { nombre: 'OEBPS/portada.xhtml', datos: b(xhtml(doc.title, lang, titlePage(doc, now))) },
    ...chunks.map((c, i) => ({
      nombre: `OEBPS/${partName(i)}`,
      datos: b(xhtml(partLabel(i), lang, blockHtml(c))),
    })),
  ]);
}

/** El mismo texto en PDF A4 (la opción «pdf»): primera página con los datos y el texto. */
export async function buildPdf(doc: KindleDoc): Promise<Buffer> {
  const head = [
    doc.author ? `Autor: ${doc.author}` : '',
    doc.date ? `Fecha: ${dateLabel(doc.date)}` : '',
    doc.source ? `Fuente: ${doc.source}` : '',
    doc.url ? `Enlace: ${doc.url}` : '',
    doc.note ? `Qué es: ${doc.note}` : '',
    'Copia para lectura personal; no redistribuir.',
  ].filter(Boolean);
  const body = doc.blocks.map((b) =>
    b.t === 'h' ? `\n${b.text.toUpperCase()}` : b.t === 'li' ? `• ${b.text}` : b.text,
  );
  return crearPdf({ titulo: doc.title, texto: `${head.join('\n')}\n\n${body.join('\n\n')}` });
}

// ─── Qué cosas van al Kindle ─────────────────────────────────────────────────────

function isPodcast(item: BandejaItem): boolean {
  return (
    /(^|\.)spotify\.com\//i.test((item.url ?? '').replace(/^https?:\/\//, '')) ||
    /podcast/i.test(item.extra.source ?? '')
  );
}

/** Un vídeo o un audio (lo que se «mira» o «escucha», aunque tengamos su transcripción). */
export function isMediaItem(item: BandejaItem): boolean {
  if (item.kind === 'youtube' || isPodcast(item)) return true;
  return item.kind === 'x' && item.extra.basis === 'transcripcion';
}

/** ¿Tiene sentido el botón «📖 Al Kindle»? Lo que se lee, y lo transcrito de verdad. */
export function kindleable(item: BandejaItem): boolean {
  if (item.state === 'descartado') return false;
  if (item.kind === 'pdf') return Boolean(item.fileId || item.url);
  if (item.kind === 'youtube' || isPodcast(item)) return item.extra.basis === 'transcripcion';
  if (item.kind === 'x') return true;
  if (item.kind === 'enlace') return Boolean(item.url);
  // Un EPUB, DOCX u ODT que mandaste.
  if (item.kind === 'texto' && item.fileId) return readableDocKind(item) !== null;
  return false;
}

/** «/bandeja kindle auto on»: solo lo 🔴 que es para leer entero (no los vídeos). */
export function autoKindle(item: BandejaItem): boolean {
  return (
    item.status === 'listo' &&
    item.verdict === 'imprescindible' &&
    kindleable(item) &&
    !isMediaItem(item)
  );
}

export interface KindleSettings {
  auto: boolean;
  /** La dirección @kindle.com del dueño; null = correo apagado. */
  email: string | null;
}

/** Lo que manda: «/bandeja kindle …» (meta) y, si no, PA_KINDLE_EMAIL / PA_KINDLE_AUTO. */
export function kindleSettings(
  store: BandejaStore,
  env: NodeJS.ProcessEnv = process.env,
): KindleSettings {
  const autoMeta = store.getMeta('kindle_auto');
  const autoEnv = ['1', 'on', 'si', 'sí', 'true'].includes(
    (env.PA_KINDLE_AUTO ?? '').trim().toLowerCase(),
  );
  const emailMeta = store.getMeta('kindle_email');
  const raw = emailMeta === 'off' ? '' : (emailMeta ?? env.PA_KINDLE_EMAIL ?? '').trim();
  return {
    auto: autoMeta ? autoMeta === 'on' : autoEnv,
    email: raw && isKindleAddress(raw) ? raw : null,
  };
}

// ─── Entrega ─────────────────────────────────────────────────────────────────────

export interface KindleDeliverDeps {
  store: BandejaStore;
  chatId: string;
  /** HTML de una página pública (el mismo fetch de la bandeja). */
  fetchRaw: FetchRaw;
  /** Bytes de un fichero de Telegram (el PDF que mandó Nico). */
  download?: (fileId: string) => Promise<Buffer | null>;
  /** Bytes de un PDF por enlace (descarga directa, comprobada). */
  fetchPdf?: (url: string) => Promise<Buffer | null>;
  /** El texto entero por el camino del procesado (transcripción, post de X). */
  readable?: (
    item: BandejaItem,
  ) => Promise<{ title: string | null; text: string; extra: BandejaExtra }>;
  /** EPUB → AZW3 con Calibre; por defecto epubToAzw3 (busca ebook-convert). */
  convert?: (epub: Buffer, title: string) => Promise<Azw3Result>;
  /** Manda un fichero al chat de Nico. */
  sendFile: (bytes: Buffer, name: string, caption: string) => Promise<void>;
  /** El correo de Asistenta (el mismo que usa el Kindle de los libros). */
  mail?: {
    account: () => Promise<MailAccount | null>;
    send: (account: MailAccount, req: SendRequest) => Promise<SendResult>;
  };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KindleTarget {
  item?: BandejaItem;
  /** Un enlace que no está en la bandeja (/kindle <enlace>). */
  url?: string;
  /** Además del EPUB, el PDF. */
  pdf?: boolean;
}

type Built =
  | { kind: 'doc'; doc: KindleDoc }
  | { kind: 'pdf'; bytes: Buffer; title: string }
  | { kind: 'epub'; bytes: Buffer; title: string }
  | { kind: 'link'; url: string | null; title: string; reason: string };

function pseudoItem(url: string, chatId: string): BandejaItem {
  return {
    id: 0,
    chatId,
    kind: kindOfUrl(url),
    url,
    title: null,
    note: null,
    fileId: null,
    fileName: null,
    mimeType: null,
    status: 'nuevo',
    error: null,
    verdict: null,
    score: null,
    reason: null,
    ideas: [],
    costMin: null,
    costLabel: null,
    extra: {},
    state: 'pendiente',
    createdAt: new Date(0).toISOString(),
    processedAt: null,
    day: '',
    carried: 0,
    digestedAt: null,
  };
}

/** Nombre para el libro y los avisos (sin depender de formato.ts). */
function nameOf(item: BandejaItem): string {
  const t = item.title?.trim() || item.fileName?.trim() || item.url || 'documento';
  return t.length > 100 ? `${sliceSafe(t, 99)}…` : t;
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 140);
}

/** «403 for https://…», «401 Unauthorized…»: la página pide sesión o suscripción. */
function fetchFailReason(err: unknown): string {
  const msg = errText(err);
  if (/\b(401|402|403)\b/.test(msg))
    return 'la página no me deja leerla (pide sesión o suscripción, o me bloquea)';
  if (/timed out|timeout/i.test(msg)) return 'la página no contestó a tiempo';
  return `no pude abrir la página (${msg})`;
}

function docNote(item: BandejaItem): string | undefined {
  if (item.kind === 'youtube') return 'Transcripción del vídeo';
  if (isPodcast(item)) return 'Transcripción del episodio';
  if (item.kind === 'x')
    return item.extra.basis === 'transcripcion'
      ? 'Post de X con la transcripción de su vídeo'
      : 'Post de X';
  return undefined;
}

/** El texto de una cosa en bloques: la transcripción cosida en párrafos; lo demás, tal cual. */
function itemBlocks(item: BandejaItem, text: string): Block[] {
  if (!isMediaItem(item) && !/\nTranscripción del vídeo:\n/.test(text)) return textBlocks(text);
  // Post de X con vídeo: «Texto del post: …\n\nTranscripción del vídeo:\n…».
  const m = /^Texto del post: ([\s\S]*?)\n\nTranscripción del vídeo:\n([\s\S]*)$/.exec(text);
  if (m)
    return [
      { t: 'h', text: 'El post' },
      ...textBlocks(m[1] ?? ''),
      { t: 'h', text: 'Transcripción del vídeo' },
      ...transcriptBlocks(m[2] ?? ''),
    ];
  return transcriptBlocks(text);
}

function itemDoc(item: BandejaItem, text: string, title: string | null): KindleDoc {
  const doc: KindleDoc = {
    title: title ?? item.title ?? nameOf(item),
    blocks: itemBlocks(item, text),
  };
  if (item.extra.author) doc.author = item.extra.author;
  if (item.extra.source) doc.source = item.extra.source;
  if (item.url) doc.url = displayUrl(item.url);
  const note = docNote(item);
  if (note) doc.note = note;
  return doc;
}

async function buildFor(item: BandejaItem, deps: KindleDeliverDeps): Promise<Built> {
  const title = item.title ?? nameOf(item);
  if (item.kind === 'pdf') {
    let bytes: Buffer | null = null;
    try {
      if (item.fileId && deps.download) bytes = await deps.download(item.fileId);
      else if (item.url && deps.fetchPdf) bytes = await deps.fetchPdf(item.url);
    } catch {
      bytes = null;
    }
    if (!bytes)
      return {
        kind: 'link',
        url: item.url,
        title,
        reason: item.fileId
          ? 'no pude bajar el PDF de Telegram (¿más de 20 MB?)'
          : 'no pude bajar el PDF',
      };
    return { kind: 'pdf', bytes, title: item.fileName?.replace(/\.pdf$/i, '') || title };
  }
  // Un EPUB que mandó Nico: el original tal cual (y su AZW3 con Calibre).
  if (item.kind === 'texto' && item.fileId && readableDocKind(item) === 'epub') {
    const bytes = deps.download ? await deps.download(item.fileId).catch(() => null) : null;
    if (!bytes)
      return {
        kind: 'link',
        url: null,
        title,
        reason: 'no pude bajar el EPUB de Telegram (¿más de 20 MB?)',
      };
    return { kind: 'epub', bytes, title: item.fileName?.replace(/\.epub$/i, '') || title };
  }
  if (item.kind === 'enlace' && item.url && !isPodcast(item)) {
    let html: string;
    try {
      html = await deps.fetchRaw(item.url);
    } catch (err) {
      const stored = item.id ? deps.store.getText(item.id) : null;
      if (stored && item.extra.basis === 'texto')
        return { kind: 'doc', doc: itemDoc(item, stored, item.title) };
      return { kind: 'link', url: item.url, title, reason: fetchFailReason(err) };
    }
    try {
      const { doc } = await readArticle(html, displayUrl(item.url));
      return { kind: 'doc', doc };
    } catch (err) {
      if (err instanceof KindleWall)
        return { kind: 'link', url: item.url, title, reason: err.message };
      return {
        kind: 'link',
        url: item.url,
        title,
        reason: `no pude leer la página (${errText(err)})`,
      };
    }
  }
  if (!kindleable(item) && item.id)
    return {
      kind: 'link',
      url: item.url,
      title,
      reason:
        item.kind === 'youtube' || isPodcast(item)
          ? 'no tengo su transcripción (solo la descripción), así que no hay texto que leer'
          : 'eso no es algo para leer',
    };
  const stored = item.id ? deps.store.getText(item.id) : null;
  if (stored) return { kind: 'doc', doc: itemDoc(item, stored, item.title) };
  if (!deps.readable)
    return { kind: 'link', url: item.url, title, reason: 'no tengo su texto guardado' };
  try {
    const r = await deps.readable(item);
    if (item.id) deps.store.saveText(item.id, r.text);
    return {
      kind: 'doc',
      doc: itemDoc(
        { ...item, extra: { ...r.extra, ...item.extra } },
        r.text,
        r.title ?? item.title,
      ),
    };
  } catch (err) {
    return { kind: 'link', url: item.url, title, reason: errText(err) };
  }
}

/** Sin Calibre: se dice UNA vez cómo ponerlo (nunca se instala solo); si falló, el porqué. */
function calibreNote(azw3: Azw3Result, store: BandejaStore, lines: string[]): void {
  if (azw3.ok) return;
  if (azw3.reason !== 'no-converter') {
    lines.push(`⚠️ El AZW3 no salió (${azw3.message}); te dejo el EPUB.`);
    return;
  }
  if (store.getMeta('kindle_calibre_hint') === 'shown') return;
  store.setMeta('kindle_calibre_hint', 'shown');
  lines.push(
    'ℹ️ No tengo Calibre en el PC, así que va en EPUB: por correo a tu Kindle Amazon lo convierte solo. Para el AZW3 del Paperwhite por USB, instala Calibre una vez: winget install calibre.calibre (no lo instalo yo).',
  );
}

/** «Mándame lo que me pasaste para leer»: arma los ficheros, los manda y dice qué pasó. */
export async function deliverToKindle(
  target: KindleTarget,
  deps: KindleDeliverDeps,
): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const settings = kindleSettings(deps.store, deps.env);
  let item = target.item ?? null;
  if (!item && target.url) {
    // Un enlace que ya estaba en la bandeja: el mismo (con su texto guardado).
    const key = canonicalKey(target.url);
    item = deps.store.findPendingByKey(deps.chatId, key) ?? pseudoItem(target.url, deps.chatId);
  }
  if (!item) return 'Dime qué: «/kindle <enlace>» o «/kindle 12» (el número de la bandeja).';
  const built = await buildFor(item, deps);
  if (built.kind === 'link') {
    return [
      `📖 «${built.title}» no va al Kindle: ${built.reason}.`,
      built.url ? `🔗 Aquí lo tienes para leerlo directamente: ${displayUrl(built.url)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const lines: string[] = [];
  const files: Array<{ bytes: Buffer; name: string; caption: string }> = [];
  let mailFile: { bytes: Buffer; name: string } | null = null;
  let title: string;
  if (built.kind === 'pdf') {
    title = built.title;
    const name = safeFilename(title, 'pdf');
    files.push({ bytes: built.bytes, name, caption: `📖 ${title} · el PDF original, tal cual` });
    mailFile = { bytes: built.bytes, name };
    lines.push(`📖 «${title}»: te paso el PDF original tal cual (el Kindle lo abre).`);
  } else if (built.kind === 'epub') {
    // El EPUB que mandaste: tal cual (por correo, Amazon lo convierte) y su AZW3 para USB.
    title = built.title;
    const name = safeFilename(title, 'epub');
    mailFile = { bytes: built.bytes, name };
    const azw3 = await (deps.convert ?? ((e: Buffer, t: string) => epubToAzw3(e, t)))(
      built.bytes,
      title,
    ).catch((err: unknown): Azw3Result => ({ ok: false, reason: 'failed', message: errText(err) }));
    if (azw3.ok)
      files.push({
        bytes: azw3.azw3,
        name: name.replace(/\.epub$/, '.azw3'),
        caption: `📖 ${title} · AZW3 para el Paperwhite (por USB, a la carpeta documents)`,
      });
    files.push({ bytes: built.bytes, name, caption: `📖 ${title} · el EPUB original, tal cual` });
    lines.push(
      `📖 «${title}»: ${azw3.ok ? 'el AZW3 del Paperwhite (por USB) y ' : ''}el EPUB original tal cual.`,
    );
    calibreNote(azw3, deps.store, lines);
  } else {
    const doc = built.doc;
    title = doc.title;
    const epub = buildEpub(doc, now);
    const epubName = safeFilename(title, 'epub');
    mailFile = { bytes: epub, name: epubName };
    const convert = deps.convert ?? ((e: Buffer, t: string) => epubToAzw3(e, t));
    const azw3 = await convert(epub, title).catch(
      (err: unknown): Azw3Result => ({ ok: false, reason: 'failed', message: errText(err) }),
    );
    if (azw3.ok) {
      files.push({
        bytes: azw3.azw3,
        name: epubName.replace(/\.epub$/, '.azw3'),
        caption: `📖 ${title} · AZW3 para el Paperwhite (por USB, a la carpeta documents)`,
      });
    }
    files.push({
      bytes: epub,
      name: epubName,
      caption: `📖 ${title} · EPUB (para «Enviar a Kindle»)`,
    });
    if (target.pdf) {
      try {
        files.push({
          bytes: await buildPdf(doc),
          name: safeFilename(title, 'pdf'),
          caption: `📄 ${title} · PDF`,
        });
      } catch (err) {
        lines.push(`⚠️ El PDF no salió (${errText(err)}).`);
      }
    }
    const words = wordCount(doc.blocks);
    lines.unshift(
      `📖 «${title}» listo para el Kindle: ${azw3.ok ? 'AZW3 (Paperwhite, por USB) y EPUB' : 'EPUB'}${target.pdf ? ' + PDF' : ''} · ~${Math.max(1, Math.round(words / 230))} min de lectura.`,
    );
    calibreNote(azw3, deps.store, lines);
  }
  const tooBig = files.filter((f) => f.bytes.length > MAX_SEND_BYTES);
  for (const f of files) {
    if (f.bytes.length > MAX_SEND_BYTES) continue;
    await deps.sendFile(f.bytes, f.name, f.caption);
  }
  if (tooBig.length)
    lines.push(
      `⚠️ ${tooBig.map((f) => f.name).join(', ')} pasa de 50 MB y Telegram no me deja mandarlo.`,
    );
  // Correo a SU Kindle, solo si lo activó (PA_KINDLE_EMAIL o /bandeja kindle correo).
  if (settings.email && mailFile && deps.mail && mailFile.bytes.length > KINDLE_MAIL_MAX_BYTES)
    lines.push(
      `📧 «${mailFile.name}» pesa ${Math.round(mailFile.bytes.length / 1_000_000)} MB: no cabe en un correo (unos 18 MB como mucho), así que no lo mando a tu Kindle. Pásalo por USB o con la app «Enviar a Kindle».`,
    );
  else if (settings.email && mailFile && deps.mail) {
    const account = await deps.mail.account().catch(() => null);
    if (!account)
      lines.push(
        '📧 No hay correo de Asistenta configurado para enviar, así que va solo por aquí.',
      );
    else {
      const r = await deps.mail
        .send(account, {
          to: [settings.email],
          subject: title.slice(0, 120),
          text: 'Para leer en el Kindle, enviado desde Asistenta (uso personal).',
          attachments: [{ filename: mailFile.name, content: mailFile.bytes }],
        })
        .catch((err: unknown): SendResult => ({ ok: false, error: errText(err) }));
      if (r.ok) {
        lines.push(`📧 Enviado a tu Kindle (${settings.email}).`);
        if (deps.store.getMeta('kindle_sender_hint') !== 'shown') {
          deps.store.setMeta('kindle_sender_hint', 'shown');
          lines.push(
            `Si no aparece en unos minutos, añade ${account.address} como remitente aprobado: Amazon → Contenido y dispositivos → Preferencias → Documentos personales.`,
          );
        }
      } else
        lines.push(
          `📧 El correo al Kindle falló (${r.error ?? 'error'}); los ficheros los tienes aquí.`,
        );
    }
  }
  return lines.join('\n');
}

/**
 * ¿Es «kindle» lo que contesta Nico a una cosa? «kindle», «al kindle», «📖», «mándalo al
 * kindle», «kindle pdf». Una frase más larga es conversación, no esto.
 */
export function kindleReplyWord(text: string): { pdf: boolean } | null {
  const t = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/^📖[\s.!]*$/u.test(t)) return { pdf: false };
  const m =
    /^(?:📖\s*)?(?:(?:al|a|mandalo al|mandamelo al|pasalo al|pasamelo al|envialo al|enviamelo al)\s+)?kindle(?:\s+(?:y\s+|en\s+)?(pdf))?[\s.!]*$/u.exec(
      t,
    );
  return m ? { pdf: Boolean(m[1]) } : null;
}

/** «/bandeja kindle» a secas: cómo está y cómo se usa. */
export function kindleStatusText(
  store: BandejaStore,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const s = kindleSettings(store, env);
  return [
    '📖 Al Kindle: toca «📖 Al Kindle» en una ficha o en el resumen, contesta «kindle» a una cosa, o «/kindle <enlace>».',
    'Va el texto entero en EPUB (y AZW3 del Paperwhite si hay Calibre en el PC); «/kindle 12 pdf» también en PDF. Los PDF van tal cual.',
    `📧 Correo a tu Kindle: ${s.email ? `encendido (${s.email})` : 'apagado'} · «/bandeja kindle correo tu@kindle.com» o «/bandeja kindle correo off».`,
    `🔴 Automático: ${s.auto ? 'encendido (lo 🔴 para leer entero te llega solo)' : 'apagado'} · «/bandeja kindle auto on|off».`,
    'Solo para ti; con muro de pago o sesión te paso el enlace, no lo salto.',
  ].join('\n');
}
