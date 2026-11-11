/**
 * Receta → lista de la compra (idea de Muse: «apúntame lo de la receta»).
 *
 * «/compra receta <enlace>» o «/compra receta» + el texto pegado (o lo que el modelo leyó de
 * una foto) apunta los ingredientes en la lista de la compra de este chat. Sin modelo y
 * gratis: casi todas las webs de recetas publican los ingredientes en su ficha
 * schema.org `Recipe` (JSON-LD, `recipeIngredient`), que es lo primero que se mira; si no
 * hay ficha, se toma la sección «Ingredientes» del texto hasta «Preparación».
 *
 * Lo que se da por hecho en casa (sal, pimienta, agua) no se apunta, y se dice.
 */
import { decodeEntities } from './tools/fetch.js';

const MAX_INGREDIENTS = 60;
const MAX_ITEM_CHARS = 60;

export interface RecetaParsed {
  title?: string;
  ingredients: string[];
  /** De dónde salieron: la ficha schema.org o la sección «Ingredientes» del texto. */
  source: 'schema' | 'texto' | 'ninguno';
}

const foldTxt = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Lo que se supone que hay en casa: no se apunta (se puede añadir a mano). */
const PANTRY = new Set(['sal', 'pimienta', 'pimienta negra', 'sal y pimienta', 'agua', 'hielo']);

function isRecipeType(t: unknown): boolean {
  if (typeof t === 'string') return /(^|\/)Recipe$/i.test(t);
  return Array.isArray(t) && t.some(isRecipeType);
}

function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (isRecipeType(o['@type'])) return o;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const r = findRecipe(o[key], depth + 1);
    if (r) return r;
  }
  return null;
}

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, ' ');

/** La ficha schema.org `Recipe` de una página, si la publica. */
export function recipeFromHtml(html: string): RecetaParsed | null {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data: unknown;
    try {
      data = JSON.parse((m[1] ?? '').trim());
    } catch {
      continue;
    }
    const recipe = findRecipe(data);
    if (!recipe) continue;
    const raw = recipe.recipeIngredient ?? recipe.ingredients;
    const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => decodeEntities(stripTags(x)));
    if (!list.length) continue;
    const name =
      typeof recipe.name === 'string' ? decodeEntities(stripTags(recipe.name)).trim() : '';
    return { ...(name ? { title: name } : {}), ingredients: list, source: 'schema' };
  }
  return null;
}

const HEAD_INGR = /^\s*(?:#+\s*)?(?:los\s+)?ingredientes\b[^\n]*$/i;
const HEAD_END =
  /^\s*(?:#+\s*)?(?:preparaci[oó]n|elaboraci[oó]n|pasos|instrucciones|modo de (?:hacer|preparaci[oó]n)|c[oó]mo (?:se )?hace|procedimiento|method|directions|steps)\b/i;

/** La sección «Ingredientes» de un texto pegado (o de una página sin ficha). */
export function recipeFromText(text: string): RecetaParsed {
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => HEAD_INGR.test(l));
  const out: string[] = [];
  if (start >= 0) {
    // «Ingredientes: harina, huevos y leche» en la misma línea.
    const inline = (lines[start] ?? '').replace(/^[^:]*:/, '').trim();
    if (inline && /:/.test(lines[start] ?? '')) out.push(...inline.split(/\s*[,;]\s*/));
    for (const l of lines.slice(start + 1)) {
      if (HEAD_END.test(l)) break;
      // Huecos y subtítulos («Para la salsa:») no cortan la lista: corta «Preparación».
      if (!l.trim()) continue;
      if (/^\s*(?:para (?:el|la|los|las)\b[^:]*|[^:]{0,30}):\s*$/i.test(l)) continue;
      out.push(l);
    }
  } else {
    // Sin título: solo las líneas que parecen ingredientes (viñeta o cantidad delante).
    for (const l of lines) {
      if (HEAD_END.test(l)) break;
      if (
        /^\s*(?:[-•*·▪]|\d+(?:[.,/]\d+)?(?![.)\d])\s*(?:g|gr|kg|ml|l|cl|dl|cucharad\w*|tazas?|vasos?|unidades?|dientes?|latas?|sobres?|pizca|\b))/i.test(
          l,
        )
      )
        out.push(l);
    }
  }
  return { ingredients: out, source: out.length ? 'texto' : 'ninguno' };
}

/** Una línea de ingrediente lista para la compra: sin viñetas, sin «al gusto», ≤60 letras. */
export function cleanIngredient(line: string): string {
  let t = decodeEntities(line)
    .replace(/^[\s\-•*·▪☐□✓✔]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\s*[,(]?\s*\b(?:al gusto|c\/?s|cantidad necesaria|opcional)\b\)?\s*$/i, '').trim();
  t = t.replace(/[.;:,]+$/, '').trim();
  if (t.length > MAX_ITEM_CHARS) {
    // «200 g de harina de trigo, tamizada y …» → hasta la primera coma si cabe.
    const comma = t.indexOf(',');
    t =
      comma > 3 && comma <= MAX_ITEM_CHARS ? t.slice(0, comma) : t.slice(0, MAX_ITEM_CHARS).trim();
  }
  return t;
}

/** Quita cantidades y unidades para saber qué es («2 cucharadas de sal» → «sal»). */
export function ingredientBase(item: string): string {
  return foldTxt(item)
    .replace(/^[\d\s.,/½¼¾⅓⅔-]+/, '')
    .replace(
      /^(?:g|gr|gramos?|kg|kilos?|ml|l|litros?|cl|dl|cucharad(?:a|as|ita|itas)|cdas?|cdtas?|tazas?|vasos?|pizcas?|chorritos?|chorros?|pu[nñ]ados?|unidades?|dientes?|latas?|sobres?|ramitas?|hojas?|un|una|unos|unas)\b\.?\s*/,
      '',
    )
    .replace(/^(?:de|del)\s+/, '')
    .replace(/\s+(?:al gusto|fina|gorda|en grano|molida|recien molida)$/, '')
    .trim();
}

export interface RecetaItems {
  title?: string;
  items: string[];
  /** Lo de casa que no se apunta (sal, pimienta, agua). */
  skipped: string[];
  source: RecetaParsed['source'];
}

/** De la receta (HTML o texto) a la lista: limpia, sin repetidos, sin lo de casa. */
export function recetaItems(input: { html?: string; text?: string }): RecetaItems {
  const parsed =
    (input.html ? recipeFromHtml(input.html) : null) ??
    recipeFromText(
      input.text ??
        decodeEntities(
          stripTags(
            (input.html ?? '')
              .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
              .replace(/<(?:br|\/p|\/li|\/h\d|\/div|li)\b[^>]*>/gi, '\n'),
          ),
        ),
    );
  const items: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.ingredients) {
    const t = cleanIngredient(raw);
    if (!t || t.length < 2) continue;
    const key = foldTxt(t);
    if (seen.has(key)) continue;
    seen.add(key);
    if (PANTRY.has(ingredientBase(t))) skipped.push(t);
    else items.push(t);
    if (items.length >= MAX_INGREDIENTS) break;
  }
  return {
    ...(parsed.title ? { title: parsed.title } : {}),
    items,
    skipped,
    source: parsed.ingredients.length ? parsed.source : 'ninguno',
  };
}

/** La nota que acompaña a la lista tras apuntar una receta. */
export function recetaNote(
  r: RecetaItems,
  added: readonly string[],
  already: readonly string[],
): string {
  if (!r.items.length && !r.skipped.length)
    return 'No encontré los ingredientes de esa receta. Pégame el texto de la receta (o la lista de ingredientes) con /compra receta y los apunto.';
  const parts = [
    `🍳 ${r.title ? `«${r.title}»` : 'Receta'}: ${added.length ? `apunto ${added.length} ${added.length === 1 ? 'ingrediente' : 'ingredientes'}` : 'nada nuevo que apuntar'}.`,
  ];
  if (already.length) parts.push(`Ya estaba: ${already.join(', ')}.`);
  if (r.skipped.length)
    parts.push(
      `No apunto ${r.skipped.join(', ')} (se suponen en casa); si hace falta, /compra ${ingredientBase(r.skipped[0] ?? 'sal')}.`,
    );
  return parts.join(' ');
}

/** «/compra receta https://…» → la URL; si no hay, null. */
export function recetaUrl(args: string): string | null {
  const m = /https?:\/\/\S+/i.exec(args);
  return m ? m[0].replace(/[)>\].,;]+$/, '') : null;
}
