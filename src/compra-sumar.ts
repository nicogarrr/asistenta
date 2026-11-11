/**
 * Sumar cantidades en la lista de la compra (lead de gaps-11, sobre /compra receta de Muse).
 *
 * Antes, si la lista tenía «200 g de harina» y una receta pedía «100 g de harina», quedaban
 * dos líneas, o, si el texto era idéntico (dos recetas con «2 huevos»), la segunda se daba
 * por «ya estaba» y faltaba la mitad en el súper. Ahora lo que pide la receta se suma a lo
 * que ya hay si es el mismo ingrediente y la unidad se puede sumar (g con kg, ml con l, la
 * misma cucharada, o unidades sueltas: huevos, cebollas). Si no se puede sumar (2 tazas con
 * 200 g), queda como antes, en su línea.
 */
import { ingredientBase } from './compra-receta.js';

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '¼': 0.25,
  '¾': 0.75,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
};

/** Unidades que se convierten entre sí: [familia, factor a la base]. */
const UNIT_FAMILY: Record<string, [string, number]> = {
  g: ['masa', 1],
  gr: ['masa', 1],
  gramo: ['masa', 1],
  gramos: ['masa', 1],
  kg: ['masa', 1000],
  kilo: ['masa', 1000],
  kilos: ['masa', 1000],
  ml: ['volumen', 1],
  mililitro: ['volumen', 1],
  mililitros: ['volumen', 1],
  cl: ['volumen', 10],
  dl: ['volumen', 100],
  l: ['volumen', 1000],
  litro: ['volumen', 1000],
  litros: ['volumen', 1000],
};

const OTHER_UNIT =
  /^(?:cucharad\w*|cdas?|cdtas?|tazas?|vasos?|latas?|sobres?|dientes?|pizcas?|ramitas?|hojas?|paquetes?|botes?|bolsas?|unidades?|uds?)$/;

export interface Cantidad {
  q: number;
  /** Unidad tal como va escrita («g», «kg», «cucharadas»); '' = unidades sueltas. */
  unit: string;
  /** Lo que se puede sumar entre sí: «masa», «volumen», «u:<unidad>» o «u» (sueltas). */
  family: string;
  /** Multiplicador de la unidad a la base de su familia (kg → 1000 g). */
  factor: number;
  /** Lo que va tras el número: « g de harina», « huevos». */
  rest: string;
}

/** Singular aproximado para casar «huevo» con «huevos» o «limón» con «limones». */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ces')) return `${word.slice(0, -3)}z`;
  if (/[lnrdj]es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Qué ingrediente es, comparable: sin cantidades ni unidades, sin acentos, en singular. */
export function ingredientKey(item: string): string {
  return fold(ingredientBase(item)).split(' ').filter(Boolean).map(singular).join(' ');
}

/** «200 g de harina» → 200 g; «1,5 kg de patatas» → 1,5 kg; «Aceite de oliva» → null. */
export function parseCantidad(item: string): Cantidad | null {
  const m =
    /^(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|[½¼¾⅓⅔]|\d+\s*[½¼¾⅓⅔])(\s*)([a-zA-Záéíóú]+\.?)?/.exec(
      item.trim(),
    );
  if (!m?.[1]) return null;
  const tok = m[1].replace(/\s+/g, '');
  let q: number;
  const frac = /^(\d+)\/(\d+)$/.exec(tok);
  const mixed = /^(\d+)([½¼¾⅓⅔])$/.exec(tok);
  if (frac) q = Number(frac[1]) / Number(frac[2]);
  else if (mixed) q = Number(mixed[1]) + (FRACTIONS[mixed[2] ?? ''] ?? 0);
  else if (FRACTIONS[tok] !== undefined) q = FRACTIONS[tok] ?? 0;
  else q = Number(tok.replace(',', '.'));
  if (!Number.isFinite(q) || q <= 0) return null;
  const rawUnit = (m[3] ?? '').replace(/\.$/, '');
  const unit = fold(rawUnit);
  const rest = item.trim().slice(m[1].length);
  const known = UNIT_FAMILY[unit];
  if (known) return { q, unit: rawUnit, family: known[0], factor: known[1], rest };
  if (unit && OTHER_UNIT.test(unit))
    return { q, unit: rawUnit, family: `u:${singular(unit)}`, factor: 1, rest };
  // Sin unidad: «2 huevos», «3 cebollas». La palabra que sigue es el ingrediente.
  return { q, unit: '', family: 'u', factor: 1, rest };
}

function fmt(q: number, unit: string): string {
  const u = fold(unit);
  let r: number;
  if (/^(?:g|gr|gramos?|ml|mililitros?)$/.test(u)) r = Math.round(q);
  else if (/^(?:kg|kilos?|l|litros?|cl|dl)$/.test(u)) r = Math.round(q * 100) / 100;
  else if (u) r = Math.round(q * 2) / 2;
  else r = Math.max(1, Math.ceil(q - 0.05));
  return String(r).replace('.', ',');
}

/**
 * La suma de dos líneas del mismo ingrediente, en la unidad de la que ya estaba en la lista
 * («1 kg de harina» + «200 g de harina» → «1,2 kg de harina»). null si no se pueden sumar
 * (distinto ingrediente, alguna sin cantidad, unidades que no casan).
 */
export function sumarLinea(existing: string, extra: string): string | null {
  if (ingredientKey(existing) !== ingredientKey(extra) || !ingredientKey(existing)) return null;
  const a = parseCantidad(existing);
  const b = parseCantidad(extra);
  if (!a || !b || a.family !== b.family) return null;
  const total = (a.q * a.factor + b.q * b.factor) / a.factor;
  // «1 huevo» + «2 huevos»: el texto en plural es el que vale para el total.
  const template = a.family === 'u' && a.q === 1 && b.q > 1 ? b : a;
  return `${fmt(total, template.unit)}${template.rest}`;
}
