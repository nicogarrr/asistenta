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
  /** Raciones de la receta («4 personas», recipeYield), si las dice. */
  servings?: number;
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
    const servings = servingsOf(recipe.recipeYield);
    return {
      ...(name ? { title: name } : {}),
      ...(servings ? { servings } : {}),
      ingredients: list,
      source: 'schema',
    };
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
    // «harina, huevos y leche»: también separan «y»/«e» (antes «huevos y leche» era una sola cosa).
    if (inline && /:/.test(lines[start] ?? ''))
      out.push(...inline.split(/\s*[,;]\s*|\s+(?:y|e)\s+/i).filter(Boolean));
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
  const servings = servingsOf(start >= 0 ? (lines[start] ?? '') : text.slice(0, 400));
  return {
    ...(servings ? { servings } : {}),
    ingredients: out,
    source: out.length ? 'texto' : 'ninguno',
  };
}

/** «4 personas», «para 6», «Raciones: 8», recipeYield 4 / "4 servings" / ["4"] → 4. */
export function servingsOf(v: unknown): number | undefined {
  const raw = Array.isArray(v) ? v.find((x) => typeof x === 'string' || typeof x === 'number') : v;
  if (typeof raw === 'number') return raw > 0 && raw <= 100 ? Math.round(raw) : undefined;
  if (typeof raw !== 'string') return undefined;
  const m =
    /(\d{1,3})\s*(?:personas?|raciones?|comensales|porciones?|servings?|people|pax|uds?\.?)\b/i.exec(
      raw,
    ) ??
    /(?:para|raciones?\s*:?|porciones?\s*:?|personas?\s*:?|serves?)\s*(\d{1,3})\b/i.exec(raw) ??
    (Array.isArray(v) || /^\s*\d{1,3}\s*$/.test(raw) ? /(\d{1,3})/.exec(raw) : null);
  const n = m ? Number(m[1]) : Number.NaN;
  return n > 0 && n <= 100 ? n : undefined;
}

const FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '¼': 0.25,
  '¾': 0.75,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
};

/** Cantidad redondeada para la compra: gramos/ml de 5 en 5, lo demás a medias o enteros. */
function fmtQty(q: number, unit: string): string {
  let r: number;
  if (/^(?:g|gr|gramos?|ml|mililitros?)$/i.test(unit))
    r = q >= 20 ? Math.round(q / 5) * 5 : Math.round(q);
  else if (/^(?:kg|kilos?|l|litros?)$/i.test(unit)) r = Math.round(q * 10) / 10;
  else if (unit) r = Math.round(q * 2) / 2;
  else r = Math.max(1, Math.ceil(q - 0.05)); // huevos, cebollas: no se compra medio
  return String(r).replace('.', ',');
}

/**
 * «200 g de harina» de una receta para 4, para 6 → «300 g de harina». Solo la cantidad
 * del principio; lo que no empieza por número («Aceite de oliva») queda igual.
 */
export function scaleIngredient(item: string, factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-9) return item;
  const m =
    /^(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|[½¼¾⅓⅔]|\d+\s*[½¼¾⅓⅔])(\s*)([a-zA-Záéíóú]+\.?)?/.exec(item);
  if (!m?.[1]) return item;
  const tok = m[1].replace(/\s+/g, '');
  let q: number;
  const frac = /^(\d+)\/(\d+)$/.exec(tok);
  const mixed = /^(\d+)([½¼¾⅓⅔])$/.exec(tok);
  if (frac) q = Number(frac[1]) / Number(frac[2]);
  else if (mixed) q = Number(mixed[1]) + (FRACTIONS[mixed[2] ?? ''] ?? 0);
  else if (FRACTIONS[tok] !== undefined) q = FRACTIONS[tok] ?? 0;
  else q = Number(tok.replace(',', '.'));
  if (!Number.isFinite(q) || q <= 0) return item;
  const unit = (m[3] ?? '').replace(/\.$/, '');
  const isUnit =
    /^(?:g|gr|gramos?|kg|kilos?|ml|mililitros?|l|litros?|cl|dl|cucharad\w*|cdas?|cdtas?|tazas?|vasos?|latas?|sobres?|dientes?|pizcas?|ramitas?|hojas?)$/i.test(
      unit,
    );
  return `${fmtQty(q * factor, isUnit ? unit : '')}${item.slice(m[1].length)}`;
}

/** «… para 6» / «… 6 personas» al final de /compra receta: raciones que quiere Nico. */
export function splitRaciones(args: string): { rest: string; servings?: number } {
  const m =
    /\s+(?:para\s+(\d{1,2})(?:\s*(?:personas?|raciones?|comensales))?|(\d{1,2})\s*(?:personas?|raciones?|comensales))\s*$/i.exec(
      args,
    );
  const n = m ? Number(m[1] ?? m[2]) : Number.NaN;
  return m && n > 0 ? { rest: args.slice(0, m.index).trim(), servings: n } : { rest: args };
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
  /** Raciones de la receta original, si las dice. */
  servings?: number;
  /** Raciones a las que se escaló (si se pidió y se sabía la original). */
  scaledTo?: number;
  items: string[];
  /** Lo de casa que no se apunta (sal, pimienta, agua). */
  skipped: string[];
  source: RecetaParsed['source'];
}

/** De la receta (HTML o texto) a la lista: limpia, sin repetidos, sin lo de casa. */
export function recetaItems(input: {
  html?: string;
  text?: string;
  /** Raciones que quiere Nico («para 6»): escala si la receta dice las suyas. */
  servings?: number;
}): RecetaItems {
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
  const factor =
    input.servings && parsed.servings && input.servings !== parsed.servings
      ? input.servings / parsed.servings
      : 1;
  for (const raw of parsed.ingredients) {
    const t = scaleIngredient(cleanIngredient(raw), factor);
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
    ...(parsed.servings ? { servings: parsed.servings } : {}),
    ...(factor !== 1 && input.servings ? { scaledTo: input.servings } : {}),
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
  /** Raciones que pidió Nico («para 6»), para decir si no se pudo escalar. */
  wanted?: number,
): string {
  if (!r.items.length && !r.skipped.length)
    return 'No encontré los ingredientes de esa receta. Pégame el texto de la receta (o la lista de ingredientes) con /compra receta y los apunto.';
  const scaled = r.scaledTo && r.servings ? ` (de ${r.servings} a ${r.scaledTo} raciones)` : '';
  const parts = [
    `🍳 ${r.title ? `«${r.title}»` : 'Receta'}${scaled}: ${added.length ? `apunto ${added.length} ${added.length === 1 ? 'ingrediente' : 'ingredientes'}` : 'nada nuevo que apuntar'}.`,
  ];
  if (already.length) parts.push(`Ya estaba: ${already.join(', ')}.`);
  if (wanted && !r.scaledTo)
    parts.push(
      r.servings === wanted
        ? `Ya era para ${wanted}.`
        : `La receta no dice para cuántos es, así que van las cantidades tal cual.`,
    );
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
