import type { ProductoApi } from './api.js';

/**
 * Qué producto de Mercadona es «leche», «6 huevos» o «2 barras de pan».
 *
 * Orden: 1) lo que el dueño ya eligió otra vez para esas mismas palabras (se aprende de
 * sus botones), 2) sus «habituales» de la web, 3) la búsqueda. Si la búsqueda da cosas
 * distintas que sus palabras no separan (leche entera / semidesnatada / sin lactosa), se
 * pregunta con botones en vez de adivinar; si solo hay una que encaja, se coge.
 */

export interface Producto {
  id: string;
  nombre: string;
  /** Precio de una unidad de venta, «0.83». */
  precio: string;
  /** «Brik 1 L», «Paquete 12 ud»: lo justo para distinguir en un botón. */
  formato: string;
}

export interface Peticion {
  /** Lo que dijo, limpio: «huevos». */
  texto: string;
  /** Unidades de venta a pedir. */
  cantidad: number;
  /** «12 huevos»: tamaño pedido, para escoger el paquete de 12 (y pedir 1). */
  tamano?: number;
}

export type Eleccion =
  | { tipo: 'ok'; producto: Producto; motivo: 'el de siempre' | 'habitual' | 'único' }
  | { tipo: 'elegir'; opciones: Producto[] }
  | { tipo: 'nada' };

export const plegar = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const NUMEROS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  doce: 12,
  docena: 12,
};

/** Palabras de cantidad que no son el producto: «2 barras de pan» → pan. */
const ENVASES =
  /^(?:barras?|paquetes?|botellas?|briks?|bricks?|latas?|bolsas?|cajas?|packs?|botes?|tarros?|kilos?|kg|gramos?|g|litros?|l|unidades?|uds?\.?|docenas?|media\s+docena)(?:\s+de)?\s+/;

/** «6 huevos» → {huevos, tamaño 6}; «2 leches» → {leches, 2}; «una docena de huevos» → 12. */
export function leerPeticion(raw: string): Peticion {
  let t = plegar(raw).replace(/[.;:!?¡¿]+$/g, '');
  let n: number | undefined;
  let docena = false;
  const m = /^(\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce)\s+/.exec(
    t,
  );
  if (m) {
    n = /^\d/.test(m[1] ?? '') ? Number(m[1]) : NUMEROS[m[1] ?? ''];
    t = t.slice(m[0].length);
  }
  if (/^(?:media\s+docena|docenas?)\b/.test(t)) docena = true;
  const half = /^media\s+docena/.test(t);
  let envase = false;
  const e = ENVASES.exec(t);
  if (e) {
    envase = true;
    t = t.slice(e[0].length);
  }
  t = t.replace(/^(?:de|del)\s+/, '').trim() || plegar(raw);
  if (docena) return { texto: t, cantidad: half ? 1 : (n ?? 1), tamano: half ? 6 : 12 };
  // «6 huevos»: con un número y sin envase, en cosas que se venden por paquetes de N.
  if (n && !envase && n >= 4) return { texto: t, cantidad: 1, tamano: n };
  return { texto: t, cantidad: Math.min(Math.max(n ?? 1, 1), 99) };
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('es') && !/[aeiou]es$/.test(w.slice(-3))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

const VACIAS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'con',
  'sin',
  'y',
  'en',
  'a',
  'para',
]);

function palabras(s: string): string[] {
  return plegar(s)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w && !VACIAS.has(w))
    .map(singular);
}

/** ¿Están todas las palabras pedidas en el nombre? («huevos camperos» ↔ «Huevos de gallinas camperas»). */
export function encaja(peticion: string, nombre: string): boolean {
  const want = palabras(peticion);
  if (!want.length) return false;
  const have = palabras(nombre);
  return want.every((w) =>
    have.some((h) => h === w || (w.length >= 5 && h.startsWith(w.slice(0, -1)))),
  );
}

export function aProducto(p: ProductoApi): Producto {
  const pi = p.price_instructions ?? {};
  const size = pi.unit_size ?? undefined;
  const fmt = pi.size_format ?? pi.reference_format ?? '';
  const tam = size
    ? `${Number.isInteger(size) ? size : String(size).replace('.', ',')} ${fmt}`.trim()
    : '';
  return {
    id: p.id,
    nombre: p.display_name,
    precio: String(pi.unit_price ?? pi.bulk_price ?? '?'),
    formato: [p.packaging ?? '', tam].filter(Boolean).join(' '),
  };
}

/** Elige producto para una petición. `recordados`: palabras plegadas → id elegido antes. */
export function elegirProducto(
  pet: Peticion,
  resultados: readonly ProductoApi[],
  habituales: readonly ProductoApi[],
  recordados: Readonly<Record<string, string>> = {},
): Eleccion {
  const clave = plegar(pet.texto);
  const recordado = recordados[clave];
  if (recordado) {
    const p = [...habituales, ...resultados].find((r) => r.id === recordado);
    if (p) return { tipo: 'ok', producto: aProducto(p), motivo: 'el de siempre' };
  }
  const porTamano = (lista: readonly ProductoApi[]) =>
    pet.tamano
      ? lista.filter((p) => (p.price_instructions?.unit_size ?? 0) === pet.tamano)
      : [...lista];
  const hab = porTamano(habituales.filter((h) => encaja(pet.texto, h.display_name)));
  if (hab.length === 1 && hab[0])
    return { tipo: 'ok', producto: aProducto(hab[0]), motivo: 'habitual' };
  let candidatos = resultados.filter((r) => encaja(pet.texto, r.display_name));
  const conTamano = porTamano(candidatos);
  if (conTamano.length) candidatos = conTamano;
  if (hab.length > 1) candidatos = hab;
  if (!candidatos.length) return { tipo: 'nada' };
  if (candidatos.length === 1 && candidatos[0]) {
    return { tipo: 'ok', producto: aProducto(candidatos[0]), motivo: 'único' };
  }
  return { tipo: 'elegir', opciones: candidatos.slice(0, 4).map(aProducto) };
}
