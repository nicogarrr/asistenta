/**
 * El árbol de WebDriverAgent (`/source?format=json`) resumido en una línea por elemento
 * con texto: «x y  Tipo «etiqueta»», con x e y el CENTRO en puntos, que es lo que pide
 * `iphone_pantalla tocar`. El árbol entero son miles de líneas de contenedores vacíos;
 * esto deja lo que el modelo puede leer y tocar.
 *
 * Idea tomada de phoneuse (github.com/lxe/phoneuse, MIT): que el agente lea la pantalla
 * como texto con posiciones y no como imagen ni volcado. phoneuse lo saca por OCR; aquí
 * WDA ya da las etiquetas exactas, incluido el estado de los interruptores (que el OCR
 * no ve). Código nuestro.
 *
 * Forma del JSON (WebDriverAgent, XCUIApplication+FBHelpers.m `dictionaryForElement`):
 * `type` («Button»), `label`, `name`, `value`, `rect` {x, y, width, height} en puntos,
 * `isEnabled`/`isVisible` («1»/«0») y `children`.
 */

export interface ElementoWda {
  tipo: string;
  texto: string;
  valor?: string;
  x: number;
  y: number;
  desactivado: boolean;
}

/** Tipos que son solo cajas: sin etiqueta propia no aportan nada. */
const CONTENEDORES = new Set([
  'Other',
  'Group',
  'ScrollView',
  'Table',
  'CollectionView',
  'Cell',
  'NavigationBar',
  'TabBar',
  'Toolbar',
  'StatusBar',
  'Keyboard',
]);

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** Toda la pantalla: nunca es lo que se busca ni lo que se toca. */
const RAIZ = new Set(['Application', 'Window']);

/** Recorre el árbol y saca los elementos visibles con texto, en orden de lectura. */
export function elementosWda(arbol: unknown, max = 400): ElementoWda[] {
  const out: ElementoWda[] = [];
  const vistos = new Set<string>();
  // Cada nodo va con la etiqueta de su padre: el texto de dentro de una celda repite la
  // de la celda, y con la celda (más grande para tocar, y con su valor) basta.
  const pila: [unknown, string][] = [[arbol, '']];
  let pasos = 0;
  while (pila.length && pasos++ < 20_000) {
    const [n, delPadre] = pila.pop() as [unknown, string];
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const tipo = str(o.type) || 'Elemento';
    const etiqueta = str(o.label);
    const texto = etiqueta || (CONTENEDORES.has(tipo) ? '' : str(o.name));
    const oculto = o.isVisible === '0' || o.isVisible === false;
    if (Array.isArray(o.children) && !oculto) {
      for (let i = o.children.length - 1; i >= 0; i--)
        pila.push([o.children[i], RAIZ.has(tipo) ? '' : texto || delPadre]);
    }
    if (oculto || RAIZ.has(tipo)) continue;
    const r = (o.rect ?? {}) as Record<string, unknown>;
    const [rx, ry, rw, rh] = [r.x, r.y, r.width, r.height].map((v) =>
      typeof v === 'number' ? v : Number.NaN,
    ) as [number, number, number, number];
    if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) continue;
    let valor = str(o.value);
    if (!texto && (!valor || CONTENEDORES.has(tipo))) continue;
    if (texto && texto === delPadre) continue;
    if (tipo === 'Switch' && (valor === '1' || valor === '0')) valor = valor === '1' ? 'sí' : 'no';
    if (valor === texto) valor = '';
    const x = Math.round(rx + rw / 2);
    const y = Math.round(ry + rh / 2);
    const clave = `${texto}|${valor}|${Math.round(x / 4)}|${Math.round(y / 4)}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({
      tipo,
      texto: texto || valor,
      ...(valor && texto ? { valor } : {}),
      x,
      y,
      desactivado: o.isEnabled === '0' || o.isEnabled === false,
    });
  }
  return out.sort((a, b) => Math.round(a.y / 6) - Math.round(b.y / 6) || a.x - b.x).slice(0, max);
}

/** Tope de líneas que se devuelven. */
export const MAX_ELEMENTOS = 200;

/** Las líneas para el modelo; null si el árbol no trae nada reconocible (otro formato). */
export function resumirArbolWda(arbol: unknown, max = MAX_ELEMENTOS): string | null {
  const todos = elementosWda(arbol, 10_000);
  if (!todos.length) return null;
  const vistos = todos.slice(0, max);
  const filas = vistos.map((e) => {
    const valor = e.valor ? ` = ${e.valor}` : '';
    const off = e.desactivado ? ' (desactivado)' : '';
    return `${e.x} ${e.y}  ${e.tipo} «${e.texto}»${valor}${off}`;
  });
  const resto =
    todos.length > vistos.length
      ? `\nATENCIÓN: ${todos.length - vistos.length} elementos más no se muestran; lo que buscas puede estar entre ellos.`
      : '';
  return (
    `Pantalla del iPhone (${todos.length} elementos con texto). Cada línea: x y (centro, en puntos: valen tal cual para tocar), tipo, «etiqueta» y = valor si lo hay. Interruptores: = sí / = no.\n` +
    filas.join('\n') +
    resto
  );
}
