/**
 * Regla del error de precio (Amazon.es): cuándo un precio es tan bajo frente a una referencia
 * fiable que merece aviso, y qué falsos positivos se descartan antes de molestar a nadie.
 *
 * Referencias (se usa la MÁS BAJA de las fiables, para no inflar el descuento):
 * - historial propio del ASIN: mediana de las lecturas, si hay al menos 3 en 24 h o más;
 * - «Precio más bajo reciente» de Amazon (30 días): fiable;
 * - «Recomendado»/«Antes» tachado: solo fiable si la ficha confirma que vende Amazon (los
 *   vendedores externos ponen el PVP que quieren).
 * Así un producto nuevo, sin historial, también puede avisar.
 */

import type { Ficha, ItemListado, RefTipo } from './amazon.js';

export interface ConfigRegla {
  /** Avisa si el precio es ≤ ratio × referencia. 0,30 = 70 % de descuento o más. */
  ratio: number;
  /** Referencia mínima: un «error» en algo de 15 € no merece aviso. */
  minRefCents: number;
  /** Diferencia máxima entre el precio del listado y el de la ficha. */
  tolerancia: number;
  /** Marcas que cuentan como «sin marca» (`PA_PRECIOS_SIN_MARCA`, en minúsculas). */
  sinMarca?: readonly string[];
}

export const SIN_MARCA_POR_DEFECTO = [
  'genérico',
  'generico',
  'generic',
  'genéricos',
  'sin marca',
  'unbranded',
  'no brand',
  'sin definir',
];

/** Por qué es «sin marca» (o null): marca de la lista, campo de marca vacío o título genérico. */
export function sinMarca(
  titulo: string,
  marca: string | null | undefined,
  lista: readonly string[] = SIN_MARCA_POR_DEFECTO,
): string | null {
  if (marca !== null && marca !== undefined) {
    const m = marca.trim().toLowerCase();
    if (!m) return 'producto sin marca (marca vacía)';
    if (lista.includes(m)) return `producto sin marca («${marca.trim()}»)`;
  }
  if (esGenerico(titulo)) return 'producto sin marca (título genérico)';
  return null;
}

export const CONFIG_REGLA: ConfigRegla = { ratio: 0.3, minRefCents: 4000, tolerancia: 0.05 };

export interface Lectura {
  at: number;
  cents: number;
}

export interface Referencia {
  cents: number;
  fuente: 'historial' | RefTipo;
}

const DIA = 24 * 3600 * 1000;

function mediana(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : Math.round(((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2);
}

/** Mediana del historial si es fiable: 3 lecturas o más que abarquen al menos un día. */
export function referenciaHistorial(lecturas: readonly Lectura[]): Referencia | null {
  if (lecturas.length < 3) return null;
  const ats = lecturas.map((l) => l.at);
  if (Math.max(...ats) - Math.min(...ats) < DIA) return null;
  return { cents: mediana(lecturas.map((l) => l.cents)), fuente: 'historial' };
}

/**
 * La referencia fiable más baja. `vendeAmazon` es null mientras no se ha visto la ficha: el
 * tachado «Recomendado» cuenta entonces como pista (para ir a verificar), no como prueba.
 */
export function mejorReferencia(
  lecturas: readonly Lectura[],
  tachado: { cents: number | null; tipo: RefTipo | null },
  vendeAmazon: boolean | null,
): Referencia | null {
  const refs: Referencia[] = [];
  const h = referenciaHistorial(lecturas);
  if (h) refs.push(h);
  // El tachado de un vendedor externo (también su «precio más bajo de los últimos 30 días»: lo
  // fija él) no vale solo: una tablet sin marca a 82,99 € «antes» 299,99 € en oferta flash
  // (PINGLANG Tech, 6-nov-2026) no es un error de precio. Con vendedor externo hace falta historial
  // propio. `null` = todavía no se sabe (listado): se abre la ficha para comprobarlo.
  if (tachado.cents && tachado.tipo && vendeAmazon !== false) {
    refs.push({ cents: tachado.cents, fuente: tachado.tipo });
  }
  if (!refs.length) return null;
  return refs.reduce((a, b) => (b.cents < a.cents ? b : a));
}

// Recambios, accesorios y consumibles: el precio no es el del aparato que da la referencia
// (la Conga a 22,90 € era esto: un recambio con el nombre del robot en el título).
const ACCESORIO_EN =
  /\b(recambios?|repuestos?|accesorios? (?:para|compatibles?)|kit de (?:recambio|accesorios|cepillos|filtros)|compatibles? con|piezas de repuesto)\b/i;
// El título EMPIEZA por la pieza («Cepillo lateral para Conga…», «Funda iPhone…»).
const ACCESORIO_INICIO =
  /^\s*(?:\S+\s+)??(?:pack de \d+ |\d+ (?:x |uds?\.? )?)?(cepillos?|filtros?|bolsas?|mopas?|pa[ñn]os?|fundas?|carcasas?|protectores? de pantalla|cristal(?:es)? templados?|cables?|cargador(?:es)?|adaptador(?:es)?|correas?|soportes?|bater[ií]as? (?:de repuesto|para)|mandos? para)\b/i;

// Productos sin marca: fuera (Nico, 6-nov-2026: «Quita productos sin marca»). Un título que
// empieza por el tipo de producto («2026 Tablet 10 Pulgadas…», «Reloj Inteligente Mujer
// Hombre…», «PC Gaming Portátil…») sin una marca conocida al principio es genérico.
const GENERICO_INICIO =
  /^\s*(?:(?:19|20)\d{2}\s+)?(?:nuevo\s+|new\s+)?(?:tablets?|tabletas?|reloj(?:es)? inteligentes?|reloj(?:es)?|smart ?watch(?:es)?|pulseras?(?: de actividad)?|pc(?: gaming)?|mini pc|port[aá]til(?:es)?|ordenador(?:es)?|auriculares|cascos|altavoz|altavoces|proyector(?:es)?|m[oó]vil(?:es)?|smartphones?|tel[eé]fonos? m[oó]vil(?:es)?|teclados?|ratones|rat[oó]n|c[aá]maras?|monitor(?:es)?|robots? aspirador(?:es)?|aspirador(?:as?)?|power ?banks?|barras? de sonido|router(?:es)?|discos? duros?|memorias?|gafas)\b/i;
const MARCA_CONOCIDA =
  /\b(?:apple|ipad|iphone|macbook|airpods|samsung|galaxy|xiaomi|redmi|poco|huawei|honor|oppo|realme|oneplus|google|pixel|lenovo|hp|asus|acer|dell|msi|microsoft|surface|sony|bose|jbl|sennheiser|garmin|amazfit|fitbit|polar|suunto|lg|philips|dyson|roborock|dreame|ecovacs|cecotec|rowenta|logitech|razer|corsair|kingston|crucial|western digital|wd|seagate|sandisk|tp-link|netgear|nintendo|playstation|xbox|canon|nikon|gopro|dji|amazon|kindle|echo|fire tv|g\.skill|gigabyte|asrock|nzxt|noctua|cooler master|thermaltake|lian li|synology|qnap|adata|teamgroup|patriot|benq|aoc|iiyama|viewsonic|steelseries|hyperx|nvidia|geforce|rtx|amd|ryzen|radeon|intel|ironwolf)\b/i;

export function esGenerico(titulo: string): boolean {
  return GENERICO_INICIO.test(titulo) && !MARCA_CONOCIDA.test(titulo.slice(0, 80));
}

export function esAccesorio(titulo: string): boolean {
  return ACCESORIO_EN.test(titulo) || ACCESORIO_INICIO.test(titulo);
}
const NO_NUEVO =
  /\b(reacondicionad[oa]|renewed|renovad[oa]|segunda mano|usad[oa]|outlet|caja abierta|open box)\b/i;

/** Por qué este resultado NO puede ser un error de precio (o null si puede). */
export function descarteListado(it: ItemListado): string | null {
  if (it.cents === null) return 'sin precio visible';
  if (it.desde) return 'precio «desde» u otras ofertas, no el de la oferta principal';
  if (it.porUnidad) return 'precio por unidad o por kilo';
  if (NO_NUEVO.test(it.titulo)) return 'reacondicionado o de segunda mano';
  if (esAccesorio(it.titulo)) return 'recambio o accesorio';
  if (esGenerico(it.titulo)) return 'producto sin marca (título genérico)';
  return null;
}

/** ¿Es candidato? Devuelve la referencia que lo hace candidato. */
export function candidato(
  it: ItemListado,
  lecturas: readonly Lectura[],
  cfg: ConfigRegla = CONFIG_REGLA,
): Referencia | null {
  if (descarteListado(it) || it.cents === null) return null;
  const ref = mejorReferencia(lecturas, { cents: it.refCents, tipo: it.refTipo }, null);
  if (!ref || ref.cents < cfg.minRefCents) return null;
  return it.cents <= ref.cents * cfg.ratio ? ref : null;
}

export type Verificacion =
  | { ok: true; cents: number; ref: Referencia; vendedor: string }
  | { ok: false; motivo: string };

export function esAmazon(nombre: string | null): boolean {
  return !!nombre && /^amazon(?:\.es)?$/i.test(nombre.trim());
}

/** La ficha confirma el error: mismo precio, nuevo, en stock, vendedor fiable, referencia fiable. */
export function verificar(
  it: ItemListado,
  ficha: Ficha,
  lecturas: readonly Lectura[],
  cfg: ConfigRegla = CONFIG_REGLA,
): Verificacion {
  if (ficha.precioOculto || ficha.cents === null) {
    return { ok: false, motivo: 'la ficha no enseña el precio (solo en la cesta)' };
  }
  if (ficha.estado !== 'nuevo')
    return { ok: false, motivo: `la oferta principal es ${ficha.estado}` };
  if (ficha.enStock === false) return { ok: false, motivo: 'agotado' };
  if (esAccesorio(ficha.titulo)) return { ok: false, motivo: 'recambio o accesorio' };
  const sm = sinMarca(ficha.titulo || it.titulo, ficha.marca, cfg.sinMarca);
  if (sm) return { ok: false, motivo: sm };
  const visto = it.cents ?? ficha.cents;
  if (Math.abs(ficha.cents - visto) > visto * cfg.tolerancia) {
    return { ok: false, motivo: 'el precio del listado y el de la ficha no coinciden' };
  }
  const vendeAmazon = esAmazon(ficha.vendedor);
  const enviaAmazon = esAmazon(ficha.envio);
  if (!vendeAmazon && !enviaAmazon) {
    return {
      ok: false,
      motivo: `lo vende ${ficha.vendedor ?? 'un vendedor desconocido'} y no lo envía Amazon`,
    };
  }
  const tachado =
    ficha.refCents !== null
      ? { cents: ficha.refCents, tipo: ficha.refTipo }
      : { cents: it.refCents, tipo: it.refTipo };
  const ref = mejorReferencia(lecturas, tachado, vendeAmazon);
  if (!ref || ref.cents < cfg.minRefCents) return { ok: false, motivo: 'sin referencia fiable' };
  if (ficha.cents > ref.cents * cfg.ratio)
    return { ok: false, motivo: 'en la ficha el descuento no llega al umbral' };
  return { ok: true, cents: ficha.cents, ref, vendedor: ficha.vendedor ?? 'Amazon' };
}
