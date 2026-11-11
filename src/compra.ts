import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { recetaItems, recetaNote, recetaUrl, splitRaciones } from './compra-receta.js';
import { cambiarAporte, ingredientKey, sumarLinea } from './compra-sumar.js';
import { lazySchema, Type } from './core/lazy-schema.js';
import { setAsideCorrupt, writeFileReplacing } from './fs-tmp.js';

/**
 * Lista de la compra con botones de Telegram para tachar.
 *
 * Antes «añade leche a la lista» acababa en una nota suelta o en el tablero de tareas,
 * y en el súper no había forma cómoda de ir tachando. Ahora hay una lista por
 * chat (en `<estado>/lista-compra.json`):
 *
 * - «añade leche y huevos a la lista», «apunta pan en la compra», «lista de la compra:
 *   tomates, pasta» → se apuntan al momento, sin gastar un turno del modelo.
 * - «¿qué falta en la lista?», «enséñame la lista de la compra», /compra → la lista con
 *   un botón por cosa: tocarlo la tacha (✅) o la destacha (⬜) editando el mismo
 *   mensaje, y «🧹 Quitar tachados» limpia lo ya comprado.
 * - Cualquier otra forma («añade leche», por voz) la entiende el modelo con la
 *   herramienta `compra`.
 */

export const COMPRA_CALLBACK_PREFIX = 'compra:';
/** Cuántas cosas llevan botón (Telegram admite 100 botones; más es inmanejable). */
const MAX_BUTTONS = 40;
const MAX_ITEMS = 200;
const MAX_ITEM_CHARS = 60;

export interface CompraItem {
  id: number;
  text: string;
  done: boolean;
  addedAt: number;
  /**
   * Las recetas que ya contaron en esta línea (su enlace o la huella de su texto), para que
   * otra receta con la misma línea sume y la misma receta mandada otra vez no (bugs-35).
   */
  recetas?: string[];
  /**
   * Lo que puso cada receta en esta línea («2 huevos»), por su clave: si la misma receta
   * vuelve con otras raciones se cambia su parte en vez de darse por «ya estaba» (bugs-36).
   */
  aportes?: Record<string, string>;
}

interface CompraFile {
  items: CompraItem[];
  nextId: number;
}

/** Solo los aportes de las recetas que la línea aún recuerda (se quedan las 20 últimas). */
function recortaAportes(
  aportes: Record<string, string>,
  recetas: readonly string[],
): Record<string, string> {
  return Object.fromEntries(Object.entries(aportes).filter(([k]) => recetas.includes(k)));
}

export const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** «leche, pan y 6 huevos» → ['leche', 'pan', '6 huevos']. */
export function itemsFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\s*(?:,|;|\n|\s+y\s+|\s+e\s+(?=h?[ií](?![ae])))\s*/i)) {
    const t = raw
      .replace(/^[\s\-•*·]+|[\s.!¡¿?]+$/g, '')
      .replace(/^(?:también|tambien|además|ademas)\s+/i, '')
      .trim()
      .slice(0, MAX_ITEM_CHARS);
    if (!t || seen.has(fold(t))) continue;
    seen.add(fold(t));
    out.push(t);
  }
  return out;
}

/**
 * Una lista por chat (el privado del dueño, y aparte la de un grupo familiar si lo
 * hay), sin distinguir temas: `telegram:<chat>`.
 */
export function compraKey(chatKey: string): string {
  return chatKey.split(':').slice(0, 2).join(':');
}

export class CompraStore {
  readonly #path: string;
  readonly #key: string;
  readonly #now: () => number;

  constructor(path: string, key: string, now: () => number = Date.now) {
    this.#path = path;
    this.#key = compraKey(key);
    this.#now = now;
  }

  #readAll(): Record<string, unknown> {
    if (!existsSync(this.#path)) return {};
    try {
      const data = JSON.parse(readFileSync(this.#path, 'utf8')) as { lists?: unknown };
      return data.lists && typeof data.lists === 'object'
        ? (data.lists as Record<string, unknown>)
        : {};
    } catch {
      setAsideCorrupt(this.#path);
      return {};
    }
  }

  #read(): CompraFile {
    const raw = this.#readAll()[this.#key] as Partial<CompraFile> | undefined;
    const items = Array.isArray(raw?.items)
      ? raw.items.filter(
          (i): i is CompraItem =>
            Boolean(i) && typeof i.id === 'number' && typeof i.text === 'string',
        )
      : [];
    const maxId = items.reduce((m, i) => Math.max(m, i.id), 0);
    return { items, nextId: Math.max(Number(raw?.nextId) || 1, maxId + 1) };
  }

  #write(data: CompraFile): void {
    const lists = this.#readAll();
    lists[this.#key] = data;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileReplacing(this.#path, `${JSON.stringify({ lists }, null, 2)}\n`);
  }

  list(): CompraItem[] {
    return this.#read().items;
  }

  /** Apunta; lo que ya estaba tachado vuelve a «por comprar». Devuelve lo nuevo y lo que ya estaba. */
  add(texts: string[]): { added: string[]; already: string[] } {
    const data = this.#read();
    const added: string[] = [];
    const already: string[] = [];
    for (const text of texts) {
      const t = text.trim().slice(0, MAX_ITEM_CHARS);
      if (!t) continue;
      const hit = data.items.find((i) => fold(i.text) === fold(t));
      if (hit) {
        if (hit.done) {
          hit.done = false;
          added.push(hit.text);
        } else already.push(hit.text);
        continue;
      }
      if (data.items.length >= MAX_ITEMS) break;
      data.items.push({ id: data.nextId++, text: t, done: false, addedAt: this.#now() });
      added.push(t);
    }
    if (added.length) this.#write(data);
    return { added, already };
  }

  /**
   * Como `add`, pero para lo que pide una receta: si el ingrediente ya está por comprar con
   * una cantidad que se puede sumar, se suma en su línea («200 g de harina» + «100 g de
   * harina» → «300 g de harina») en vez de quedar dos líneas o darse por «ya estaba». Si ya
   * estaba sin cantidad («harina»), se da por apuntado.
   */
  addSumando(
    texts: string[],
    receta?: string,
  ): {
    added: string[];
    already: string[];
    merged: Array<{ from: string; to: string }>;
    rescaled: Array<{ from: string; to: string }>;
  } {
    const data = this.#read();
    const added: string[] = [];
    const already: string[] = [];
    const merged: Array<{ from: string; to: string }> = [];
    // Las líneas que esta receta ya tocó en esta vuelta y su texto de antes.
    const ahora = new Set<CompraItem>();
    const antesDe = new Map<CompraItem, string>();
    let changed = false;
    const marca = (item: CompraItem | undefined, aporte: string): void => {
      if (!item || !receta || item.recetas?.includes(receta)) return;
      item.recetas = [...(item.recetas ?? []), receta].slice(-20);
      item.aportes = recortaAportes({ ...(item.aportes ?? {}), [receta]: aporte }, item.recetas);
      ahora.add(item);
      changed = true;
    };
    for (const text of texts) {
      const t = text.trim().slice(0, MAX_ITEM_CHARS);
      if (!t) continue;
      const key = ingredientKey(t);
      const pending = key ? data.items.filter((i) => !i.done && ingredientKey(i.text) === key) : [];
      let done = false;
      // Esta misma receta ya contó en esa línea (aunque se sumara a otra cantidad): mandarla
      // otra vez no suma de nuevo. Antes solo lo frenaba el texto exacto y «100 g» + «200 g»
      // = «300 g» pasaba a «500 g» al repetirla.
      const counted = receta ? pending.find((i) => i.recetas?.includes(receta)) : undefined;
      if (counted && receta) {
        const antes = counted.aportes?.[receta];
        let nueva: string | null = null;
        let aporte = t;
        if (antes && ahora.has(counted)) {
          // Otra línea de la misma receta para lo mismo («2 huevos» y «1 huevo para pintar»):
          // se suma a lo que esta receta ya puso en esta vuelta.
          nueva = sumarLinea(counted.text, t);
          aporte = sumarLinea(antes, t) ?? antes;
        } else if (antes && fold(antes) !== fold(t)) {
          // …salvo que vuelva con otras raciones («para 4» → «para 6»): entonces su parte
          // cambia. Antes decía «ya estaba» y la lista seguía con lo de 4 (bugs-36).
          nueva = cambiarAporte(counted.text, antes, t);
        }
        if (nueva && nueva.length <= MAX_ITEM_CHARS) {
          if (!ahora.has(counted) && !antesDe.has(counted)) antesDe.set(counted, counted.text);
          counted.text = nueva;
          counted.aportes = { ...(counted.aportes ?? {}), [receta]: aporte };
          ahora.add(counted);
          changed = true;
        } else already.push(counted.text);
        continue;
      }
      // El mismo texto exacto («6 huevos» y «6 huevos») se da por «ya estaba», como siempre:
      // así mandar dos veces la misma receta (o que el modelo la repita) no duplica nada.
      // Si ese texto lo puso OTRA receta, esta suma lo suyo («2 huevos» + «2 huevos»).
      const same = pending.find((i) => fold(i.text) === fold(t));
      const deOtra = Boolean(receta && same?.recetas?.length);
      if (same && !deOtra) {
        already.push(same.text);
        continue;
      }
      for (const hit of same ? [same, ...pending.filter((i) => i !== same)] : pending) {
        const sum = sumarLinea(hit.text, t);
        if (sum && sum.length <= MAX_ITEM_CHARS) {
          merged.push({ from: hit.text, to: sum });
          hit.text = sum;
          marca(hit, t);
          changed = done = true;
          break;
        }
      }
      if (done) continue;
      if (same) {
        already.push(same.text);
        continue;
      }
      // Ya en la lista sin cantidad («harina»): con eso basta, como antes con el texto igual.
      const bare = pending.find((i) => !/^\s*[\d½¼¾⅓⅔]/.test(i.text));
      if (bare) {
        already.push(bare.text);
        continue;
      }
      const r = this.#addOne(data, t);
      if (r === 'full') break;
      if (r === 'already') already.push(t);
      else {
        added.push(r);
        const nuevo = data.items.find((i) => !i.done && fold(i.text) === fold(r));
        if (nuevo && receta) {
          nuevo.recetas = [receta];
          nuevo.aportes = { [receta]: t };
          ahora.add(nuevo);
        }
        changed = true;
      }
    }
    if (changed) this.#write(data);
    const rescaled = [...antesDe]
      .filter(([item, from]) => fold(item.text) !== fold(from))
      .map(([item, from]) => ({ from, to: item.text }));
    return { added, already, merged, rescaled };
  }

  /** Apunta uno sobre `data` (sin guardar): el texto apuntado, 'already' o 'full'. */
  #addOne(data: CompraFile, t: string): string | 'already' | 'full' {
    const hit = data.items.find((i) => fold(i.text) === fold(t));
    if (hit) {
      if (hit.done) {
        hit.done = false;
        hit.text = t;
        return t;
      }
      return 'already';
    }
    if (data.items.length >= MAX_ITEMS) return 'full';
    data.items.push({ id: data.nextId++, text: t, done: false, addedAt: this.#now() });
    return t;
  }

  toggle(id: number): CompraItem | null {
    const data = this.#read();
    const hit = data.items.find((i) => i.id === id);
    if (!hit) return null;
    hit.done = !hit.done;
    this.#write(data);
    return hit;
  }

  /** Tacha por nombre («ya tengo la leche»). */
  mark(text: string, done = true): CompraItem | null {
    const data = this.#read();
    const want = fold(text);
    const hit =
      data.items.find((i) => fold(i.text) === want) ??
      data.items.find((i) => fold(i.text).includes(want) || want.includes(fold(i.text)));
    if (!hit) return null;
    hit.done = done;
    this.#write(data);
    return hit;
  }

  remove(text: string): CompraItem | null {
    const data = this.#read();
    const want = fold(text);
    const idx = data.items.findIndex((i) => fold(i.text) === want);
    if (idx < 0) return null;
    const [gone] = data.items.splice(idx, 1);
    this.#write(data);
    return gone ?? null;
  }

  clearDone(): number {
    const data = this.#read();
    const before = data.items.length;
    data.items = data.items.filter((i) => !i.done);
    const n = before - data.items.length;
    if (n) this.#write(data);
    return n;
  }

  clearAll(): number {
    const data = this.#read();
    const n = data.items.length;
    if (n) this.#write({ items: [], nextId: data.nextId });
    return n;
  }
}

export interface CompraView {
  text: string;
  buttons: Array<{ label: string; action: string }>;
}

/** El mensaje de la lista: lo que falta arriba, lo tachado abajo, un botón por cosa. */
export function compraView(items: readonly CompraItem[], note?: string): CompraView {
  const pending = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  const head = note ? `${note}\n\n` : '';
  if (items.length === 0)
    return {
      text: `${head}🛒 La lista de la compra está vacía. Dime «añade leche y pan a la lista».`,
      buttons: [],
    };
  const lines = [
    pending.length
      ? `🛒 Lista de la compra: ${pending.length} por comprar`
      : '🛒 Lista de la compra: ¡todo comprado!',
    ...pending.map((i) => `⬜ ${i.text}`),
    ...done.map((i) => `✅ ${i.text}`),
  ];
  const ordered = [...pending, ...done].slice(0, MAX_BUTTONS);
  const buttons = ordered.map((i) => ({
    label: `${i.done ? '✅' : '⬜'} ${i.text}`.slice(0, 40),
    action: `${COMPRA_CALLBACK_PREFIX}t:${i.id}`,
  }));
  if (done.length)
    buttons.push({ label: '🧹 Quitar tachados', action: `${COMPRA_CALLBACK_PREFIX}limpiar` });
  if (pending.length)
    buttons.push({ label: '📋 En texto', action: `${COMPRA_CALLBACK_PREFIX}texto` });
  const more =
    pending.length + done.length > MAX_BUTTONS
      ? '\n(Toca para tachar; las primeras 40 llevan botón.)'
      : '\nToca una para tacharla.';
  return { text: `${head}${lines.join('\n')}${more}`, buttons };
}

/**
 * Lo que falta, en texto llano para copiarlo o reenviarlo (a quien va a la compra, a un
 * grupo): sin casillas ni botones, una cosa por línea.
 */
export function compraTexto(items: readonly CompraItem[]): string {
  const pending = items.filter((i) => !i.done);
  if (!pending.length) return '🛒 No falta nada en la lista de la compra.';
  return ['Lista de la compra:', ...pending.map((i) => `- ${i.text}`)].join('\n');
}

/** La lista en texto (para copiar o reenviar), con un botón para volver a la de tachar. */
export function compraTextoView(items: readonly CompraItem[]): CompraView {
  return {
    text: compraTexto(items),
    buttons: items.length
      ? [{ label: '↩️ Volver a la lista', action: `${COMPRA_CALLBACK_PREFIX}ver` }]
      : [],
  };
}

/** Pulsación de un botón de la lista: aplica y devuelve la vista nueva. */
export function compraPress(store: CompraStore, data: string): CompraView {
  const action = data.slice(COMPRA_CALLBACK_PREFIX.length);
  const toggle = /^t:(\d{1,9})$/.exec(action);
  if (toggle) store.toggle(Number(toggle[1]));
  else if (action === 'limpiar') store.clearDone();
  else if (action === 'texto') return compraTextoView(store.list());
  return compraView(store.list());
}

export type CompraIntent =
  | { kind: 'add'; items: string[] }
  | { kind: 'show' }
  | { kind: 'text' }
  | { kind: 'clearDone' }
  | { kind: 'clearAll' };

const LISTA = String.raw`(?:(?:a|en)\s+)?(?:la\s+|mi\s+)?(?:lista(?:\s+de\s+(?:la\s+)?compra)?|compra)`;
const ADD_VERB =
  '(?:añade|añádeme|anade|añadir|apunta|apúntame|apuntame|pon|ponme|mete|méteme|agrega|incluye)';

/**
 * Lo que se entiende sin modelo. Solo frases que nombran la lista: «añade leche» a
 * secas lo decide el modelo (podría ser otra cosa) con la herramienta `compra`.
 */
export function compraIntent(text: string | undefined): CompraIntent | null {
  if (!text) return null;
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length > 300) return null;
  const f = fold(t).replace(/[.!¡]+$/, '');
  if (
    /^(?:\/compra|(?:ensename|ensenam?e|muestrame|dame|pasame|mandame|ver|mira|abre)?\s*(?:la\s+|mi\s+)?lista de (?:la )?compra\??|¿?que (?:me )?(?:falta|queda)(?: por comprar)?(?: en la lista| de la compra| en la compra)\??|¿?que (?:me )?(?:falta|queda) por comprar\??)$/.test(
      f.replace(/^¿/, ''),
    )
  )
    return { kind: 'show' };
  // «pásame la lista para copiar», «comparte la lista de la compra», «la lista en texto»:
  // en texto llano, sin casillas, para reenviarla a quien va a comprar.
  if (
    /^(?:(?:pasame|mandame|dame|escribeme|ponme|comparte|compartir|reenvia)\s+)?(?:la\s+|mi\s+)?lista(?: de (?:la )?compra)?\s+(?:en texto|para (?:copiar|copiarla|reenviar|reenviarla|mandar|mandarla|compartir|compartirla|pegar|pegarla))$/.test(
      f,
    ) ||
    /^(?:comparte|compartir|reenvia) (?:la |mi )?lista de (?:la )?compra$/.test(f)
  )
    return { kind: 'text' };
  if (
    /^(?:borra(?:me)?|quita(?:me)?|limpia|elimina|vacia|saca) (?:lo|los|las) (?:ya )?(?:tachad[oa]s?|marcad[oa]s?|comprad[oa]s?)(?: de (?:la |mi )?(?:lista(?: de (?:la )?compra)?|compra))?$|^(?:borra(?:me)?|quita(?:me)?|limpia|elimina|vacia|saca) lo que (?:ya )?(?:he comprado|esta tachado|esta marcado)(?: de (?:la |mi )?(?:lista(?: de (?:la )?compra)?|compra))?$/.test(
      f,
    )
  )
    return { kind: 'clearDone' };
  if (/^(?:borra|vacia|limpia) (?:toda )?la lista de (?:la )?compra(?: entera)?$/.test(f))
    return { kind: 'clearAll' };
  const colon = /^(?:lista de (?:la )?compra|para la compra|compra)\s*:\s*(.+)$/i.exec(
    t.normalize('NFC'),
  );
  if (colon?.[1]) {
    const items = itemsFromText(colon[1]);
    return items.length ? { kind: 'add', items } : null;
  }
  // «añade a la lista de la compra leche y pan»: la lista delante (antes no se entendía).
  const listaDelante = new RegExp(
    `^${ADD_VERB}\\s+(?:a|en)\\s+(?:la\\s+|mi\\s+)?(?:lista\\s+de\\s+(?:la\\s+)?compra|compra)\\s*:?\\s+(.+?)\\s*[.!]?$`,
    'i',
  ).exec(t);
  if (listaDelante?.[1]) {
    const items = itemsFromText(listaDelante[1]);
    return items.length ? { kind: 'add', items } : null;
  }
  // «faltan huevos», «falta leche y tomate», «se ha acabado el aceite», «no queda pan»:
  // como se dice en casa durante la semana. Solo frases cortas de cosas; «falta poco»,
  // «faltan 5 minutos» o «falta que me llames» no son compra.
  const falta =
    /^(?:(?:oye|ah|ya|y)\s*,?\s+)?(?:(?:me|nos|te)\s+)?(?:falta|faltan|se (?:me |nos )?(?:ha |han )?(?:acabado|acab[oó]|acabaron|terminado|termin[oó]|terminaron)|no (?:me |nos )?queda(?:n)?(?: nada de)?)\s+(.+?)\s*[.!]?$/i.exec(
      t,
    );
  if (falta?.[1] && t.length <= 120) {
    const resto = fold(falta[1]);
    if (
      !/\d|\b(?:que|para|poco|mucho|muchos?|algo|nada|tiempo|dias?|horas?|minutos?|semanas?|meses|rato|gente|alguien|uno|una|eso|esto|aqui|tu|usted|el examen)\b/.test(
        resto,
      )
    ) {
      const items = itemsFromText(falta[1]).map((i) =>
        i.replace(/^(?:el|la|los|las|de|del)\s+/i, ''),
      );
      if (items.length && items.every((i) => i.split(/\s+/).length <= 4))
        return { kind: 'add', items };
    }
  }
  const add = new RegExp(`^${ADD_VERB}\\s+(.+?)\\s+${LISTA}\\s*[.!]?$`, 'i').exec(t);
  if (add?.[1]) {
    const items = itemsFromText(add[1]);
    return items.length ? { kind: 'add', items } : null;
  }
  return null;
}

/** Aplica una intención y da la vista a mandar (con botones). */
export function runCompraIntent(store: CompraStore, intent: CompraIntent): CompraView {
  switch (intent.kind) {
    case 'add': {
      const r = store.add(intent.items);
      const parts: string[] = [];
      if (r.added.length) parts.push(`Apuntado: ${r.added.join(', ')}.`);
      if (r.already.length) parts.push(`Ya estaba: ${r.already.join(', ')}.`);
      return compraView(store.list(), parts.join(' ') || 'No había nada nuevo que apuntar.');
    }
    case 'clearDone': {
      const n = store.clearDone();
      return compraView(store.list(), n ? `Quitadas ${n} tachadas.` : 'No había nada tachado.');
    }
    case 'clearAll': {
      const n = store.clearAll();
      return compraView([], n ? `Lista vaciada (${n}).` : undefined);
    }
    case 'text':
      return compraTextoView(store.list());
    default:
      return compraView(store.list());
  }
}

const Params = lazySchema(() =>
  Type.Object({
    accion: Type.Union(
      [
        Type.Literal('añadir'),
        Type.Literal('ver'),
        Type.Literal('tachar'),
        Type.Literal('destachar'),
        Type.Literal('quitar'),
        Type.Literal('limpiar_tachados'),
        Type.Literal('vaciar'),
        Type.Literal('texto'),
        Type.Literal('receta'),
      ],
      {
        description:
          'añadir | ver | tachar | destachar | quitar | limpiar_tachados | vaciar | texto (lo que falta en texto llano, para copiar o reenviar) | receta (apunta los ingredientes de la receta en `receta`)',
      },
    ),
    cosas: Type.Optional(
      Type.String({
        maxLength: 600,
        description: 'Lo que añadir, tachar o quitar, separado por comas («leche, pan, 6 huevos»).',
      }),
    ),
    receta: Type.Optional(
      Type.String({
        maxLength: 8000,
        description:
          'Para accion=receta: el enlace de la receta, o su texto (lo pegado o leído de una foto) con la lista de ingredientes. Termina con «para N» si el dueño quiere otras raciones.',
      }),
    ),
  }),
);

/**
 * «/compra receta <enlace o texto>»: apunta los ingredientes de una receta. Con enlace,
 * descarga la página (`fetchHtml`, con el mismo filtro SSRF que la herramienta fetch).
 */
export async function recetaACompra(
  store: CompraStore,
  input: string,
  fetchHtml?: (url: string) => Promise<string>,
): Promise<CompraView> {
  const { rest: arg, servings } = splitRaciones(input.trim());
  if (!arg)
    return {
      text: 'Mándame el enlace de la receta o pega sus ingredientes: /compra receta https://… (o el texto).',
      buttons: [],
    };
  const url = recetaUrl(arg);
  let r: ReturnType<typeof recetaItems>;
  if (url && fetchHtml) {
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch {
      return {
        text: 'No pude abrir esa receta. Pega aquí sus ingredientes con /compra receta y los apunto.',
        buttons: [],
      };
    }
    r = recetaItems({ html, ...(servings ? { servings } : {}) });
  } else {
    r = recetaItems({ text: arg, ...(servings ? { servings } : {}) });
    // Pegado sin título «Ingredientes»: una línea con comas también vale.
    if (!r.items.length && !r.skipped.length && !url)
      r = { ...r, items: itemsFromText(arg), source: 'texto' };
  }
  if (!r.items.length) {
    return { text: recetaNote(r, [], [], servings), buttons: [] };
  }
  // Qué receta es (su enlace o la huella de lo pegado): la misma no cuenta dos veces.
  const receta = url
    ? `url:${url.replace(/[?#].*$/, '').toLowerCase()}`
    : `txt:${createHash('sha256').update(fold(arg)).digest('hex').slice(0, 16)}`;
  const added = store.addSumando(r.items, receta);
  const note = recetaNote(r, added.added, added.already, servings);
  const sumado = added.merged.length
    ? ` Sumado a lo que ya tenías: ${added.merged.map((m) => `${m.from} → ${m.to}`).join(', ')}.`
    : '';
  const ajustado = added.rescaled.length
    ? ` Ajustado a las raciones nuevas: ${added.rescaled.map((m) => `${m.from} → ${m.to}`).join(', ')}.`
    : '';
  return compraView(store.list(), `${note}${sumado}${ajustado}`);
}

/** Herramienta del modelo: «añade leche», «ya he comprado el pan», «¿qué me falta?». */
export function createCompraTool(
  store: CompraStore,
  fetchHtml?: (url: string) => Promise<string>,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'compra',
    label: 'Lista de la compra',
    description:
      "The owner's shopping list (lista de la compra). Use for «añade leche», «apunta huevos para la compra», «ya he comprado el pan» (tachar), «quita las galletas», «¿qué me falta por comprar?». Items comma-separated in `cosas`. The owner can also open /compra to tick items off with buttons. For «apúntame lo de esta receta» (a recipe link, pasted recipe or a photo of one) use accion=receta with the link or the recipe text in `receta`: it adds the ingredients itself (skips salt/pepper/water). Not for to-dos (use tasks) or price watching.",
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const cosas = itemsFromText(args.cosas ?? '');
      let note = '';
      switch (args.accion) {
        case 'añadir': {
          if (!cosas.length) note = 'Dime qué añadir.';
          else {
            const r = store.add(cosas);
            note = [
              r.added.length ? `Apuntado: ${r.added.join(', ')}.` : '',
              r.already.length ? `Ya estaba: ${r.already.join(', ')}.` : '',
            ]
              .filter(Boolean)
              .join(' ');
          }
          break;
        }
        case 'tachar':
        case 'destachar': {
          const done = args.accion === 'tachar';
          const ok: string[] = [];
          const missing: string[] = [];
          for (const c of cosas) (store.mark(c, done) ? ok : missing).push(c);
          note = [
            ok.length ? `${done ? 'Tachado' : 'Vuelve a la lista'}: ${ok.join(', ')}.` : '',
            missing.length ? `No está en la lista: ${missing.join(', ')}.` : '',
          ]
            .filter(Boolean)
            .join(' ');
          break;
        }
        case 'quitar': {
          const ok = cosas.filter((c) => store.remove(c));
          note = ok.length ? `Quitado: ${ok.join(', ')}.` : 'Eso no está en la lista.';
          break;
        }
        case 'limpiar_tachados':
          note = `Quitadas ${store.clearDone()} tachadas.`;
          break;
        case 'vaciar':
          note = `Lista vaciada (${store.clearAll()}).`;
          break;
        case 'texto':
          return { content: [{ type: 'text', text: compraTexto(store.list()) }], details: {} };
        case 'receta': {
          const view = await recetaACompra(store, args.receta ?? args.cosas ?? '', fetchHtml);
          const text = `${view.text.replace(/\nToca una para tacharla\.$/, '')}\n(Con /compra el dueño la ve con botones para tachar.)`;
          return { content: [{ type: 'text', text }], details: {} };
        }
        default:
          break;
      }
      const view = compraView(store.list(), note || undefined);
      const text = `${view.text.replace(/\nToca una para tacharla\.$/, '')}\n(Con /compra el dueño la ve con botones para tachar.)`;
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}
