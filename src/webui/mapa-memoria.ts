import type { MemoryEntry } from '../memory.js';
import { looksLikeCredential } from '../memory.js';
import { foldAccents, sliceSafe } from '../text.js';

/**
 * Tarjeta «Mapa de memoria» del panel (solo lectura): los recuerdos vigentes como
 * nodos y lo que los une como enlaces, para dibujarlos en un SVG sin librerías.
 *
 * Enlaces, por orden de fuerza:
 * - `enlace`: un `[[...]]` en el texto que nombra el id, una etiqueta o el texto de otro.
 * - `reemplaza`: uno sustituye a otro (`supersedes`).
 * - `etiqueta`: comparten etiqueta (las de proyecto, p. ej. `proyecto-x`, también).
 * - `mencion`: nombran la misma cosa con mayúscula («Oviedo», «GerarAI»), salvo las
 *   que salen en casi todos (el nombre del dueño uniría todo con todo).
 *
 * Tope: los TOPE_NODOS más recientes (y se dice cuántos hay). Cada nodo guarda sus
 * MAX_ENLACES_POR_NODO enlaces más fuertes, para que una etiqueta común no dibuje una
 * maraña. Un recuerdo con pinta de contraseña o clave no sale nunca (se cuenta).
 */

export const TOPE_NODOS = 300;
export const MAX_ENLACES_POR_NODO = 6;
export const MAX_ENLACES = 1500;
const MAX_TEXTO = 300;

export type TipoEnlace = 'enlace' | 'reemplaza' | 'etiqueta' | 'mencion';

export interface NodoMapa {
  id: string;
  texto: string;
  fecha: string;
  etiquetas: string[];
  /** Enlaces que conserva tras el tope. */
  grado: number;
}

export interface EnlaceMapa {
  /** Índices en `nodos`. */
  a: number;
  b: number;
  peso: number;
  tipo: TipoEnlace;
  /** Por qué están unidos, corto («#salud», «[[Lisboa]]», «Oviedo»). */
  motivo: string;
}

export interface PanelMapa {
  nodos: NodoMapa[];
  enlaces: EnlaceMapa[];
  /** Recuerdos vigentes en el ámbito (antes del tope). */
  total: number;
  recortado: boolean;
  tope: number;
  /** Recuerdos que no salen por parecer una contraseña o clave. */
  ocultos: number;
}

const PESO: Record<TipoEnlace, number> = { enlace: 4, reemplaza: 3, etiqueta: 2, mencion: 1 };

/** Palabras que van con mayúscula por empezar frase, no por ser un nombre. */
const NO_NOMBRES = new Set(
  (
    'el la los las un una unos unas y o u e ni en de del al a con por para sin sobre su sus mi mis tu tus ' +
    'se le les lo es son esta está estan están hay no si sí que cuando como donde dónde cuál cual qué quien ' +
    'quién este esta estos estas ese esa eso tiene tienen prefiere quiere vive usa trabaja le ya muy más ' +
    'the a an and or of in on to for with is are was it he she they we you i my his her their this that ' +
    'usuario usuaria nota recuerdo'
  ).split(' '),
);

function clave(texto: string): string {
  return foldAccents(texto).toLowerCase().trim();
}

function nombresPropios(texto: string): Set<string> {
  const out = new Set<string>();
  for (const m of texto.matchAll(/(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{N}]{2,}/gu)) {
    const k = clave(m[0]);
    if (!NO_NOMBRES.has(k)) out.add(k);
  }
  return out;
}

function enlacesWiki(texto: string): string[] {
  return [...texto.matchAll(/\[\[([^[\]\r\n]{1,80})\]\]/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter(Boolean);
}

function marca(e: MemoryEntry): string {
  return `${e.date ?? ''}T${e.time ?? ''}`;
}

/** Pura: el mapa de un conjunto de recuerdos (los de un ámbito, como la tarjeta Memoria). */
export function mapaMemoria(entradas: readonly MemoryEntry[], tope = TOPE_NODOS): PanelMapa {
  let ocultos = 0;
  const vigentes: { e: MemoryEntry; i: number }[] = [];
  entradas.forEach((e, i) => {
    if (e.supersededBy) return;
    if (looksLikeCredential(e.text) || e.tags.some((t) => looksLikeCredential(t))) {
      ocultos++;
      return;
    }
    vigentes.push({ e, i });
  });
  // Los más nuevos primero; a igual fecha, el que se escribió después.
  vigentes.sort((x, y) => marca(y.e).localeCompare(marca(x.e)) || y.i - x.i);
  const limite = Math.max(0, Math.floor(tope));
  const elegidos = vigentes.slice(0, limite).map((v) => v.e);
  const n = elegidos.length;

  const pares = new Map<string, { peso: number; tipo: TipoEnlace; motivos: string[] }>();
  function unir(a: number, b: number, tipo: TipoEnlace, motivo: string): void {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}:${y}`;
    const par = pares.get(k) ?? { peso: 0, tipo, motivos: [] };
    par.peso += PESO[tipo];
    if (PESO[tipo] > PESO[par.tipo]) par.tipo = tipo;
    if (par.motivos.length < 3 && !par.motivos.includes(motivo)) par.motivos.push(motivo);
    pares.set(k, par);
  }

  const porId = new Map<string, number>();
  const porEtiqueta = new Map<string, number[]>();
  const porNombre = new Map<string, number[]>();
  const textos = elegidos.map((e) => clave(e.text));
  elegidos.forEach((e, i) => {
    porId.set(e.id, i);
    for (const t of new Set(e.tags.map(clave).filter(Boolean))) {
      const l = porEtiqueta.get(t) ?? [];
      l.push(i);
      porEtiqueta.set(t, l);
    }
    for (const nombre of nombresPropios(e.text)) {
      const l = porNombre.get(nombre) ?? [];
      l.push(i);
      porNombre.set(nombre, l);
    }
  });

  elegidos.forEach((e, i) => {
    for (const viejo of e.supersedes) {
      const j = porId.get(viejo);
      if (j !== undefined) unir(i, j, 'reemplaza', 'reemplaza');
    }
    for (const w of enlacesWiki(e.text)) {
      const k = clave(w);
      const destinos = new Set<number>();
      const j = porId.get(w);
      if (j !== undefined) destinos.add(j);
      for (const t of porEtiqueta.get(k) ?? []) destinos.add(t);
      for (let t = 0; t < n && destinos.size < 6; t++) {
        if (t !== i && (textos[t] ?? '').includes(k)) destinos.add(t);
      }
      for (const d of destinos) unir(i, d, 'enlace', `[[${sliceSafe(w, 30)}]]`);
    }
  });
  for (const [t, l] of porEtiqueta) {
    for (let x = 0; x < l.length; x++)
      for (let y = x + 1; y < l.length; y++)
        unir(l[x] as number, l[y] as number, 'etiqueta', `#${sliceSafe(t, 30)}`);
  }
  const comun = Math.max(3, Math.ceil(n * 0.2));
  for (const [nombre, l] of porNombre) {
    if (l.length < 2 || l.length > comun) continue;
    for (let x = 0; x < l.length; x++)
      for (let y = x + 1; y < l.length; y++)
        unir(l[x] as number, l[y] as number, 'mencion', sliceSafe(nombre, 30));
  }

  // Cada nodo conserva sus enlaces más fuertes; un enlace queda si es de los mejores de
  // cualquiera de sus dos extremos.
  const todos = [...pares.entries()].map(([k, v]) => {
    const [a, b] = k.split(':').map(Number) as [number, number];
    return { a, b, ...v };
  });
  todos.sort((x, y) => y.peso - x.peso || x.a - y.a || x.b - y.b);
  const cuenta = new Array<number>(n).fill(0);
  const quedan: typeof todos = [];
  for (const en of todos) {
    if (quedan.length >= MAX_ENLACES) break;
    if ((cuenta[en.a] ?? 0) >= MAX_ENLACES_POR_NODO && (cuenta[en.b] ?? 0) >= MAX_ENLACES_POR_NODO)
      continue;
    cuenta[en.a] = (cuenta[en.a] ?? 0) + 1;
    cuenta[en.b] = (cuenta[en.b] ?? 0) + 1;
    quedan.push(en);
  }

  return {
    nodos: elegidos.map((e, i) => ({
      id: e.id,
      texto: sliceSafe(e.text, MAX_TEXTO),
      fecha: e.date,
      etiquetas: e.tags.slice(0, 8).map((t) => sliceSafe(t, 40)),
      grado: cuenta[i] ?? 0,
    })),
    enlaces: quedan.map((en) => ({
      a: en.a,
      b: en.b,
      peso: en.peso,
      tipo: en.tipo,
      motivo: en.motivos.join(' · '),
    })),
    total: vigentes.length,
    recortado: vigentes.length > elegidos.length,
    tope: limite,
    ocultos,
  };
}
