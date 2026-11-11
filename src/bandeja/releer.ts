/**
 * «🔄 Releer la página» de la bandeja: lo guardado antes de que existieran «🛒 A la compra»
 * (#2340) y «📅 Al calendario» (#2346) no trae `extra.receta` ni `extra.evento`, así que su
 * ficha no ofrecía esos botones aunque la página fuera una receta o un congreso. Esto vuelve
 * a abrir la página y lee SOLO sus fichas schema.org (Recipe, Event): sin modelo, gratis, y
 * sin tocar la nota, el veredicto ni las ideas.
 */
import { recipeFromHtml } from '../compra-receta.js';
import { eventFromHtml } from './evento.js';
import type { BandejaExtra, BandejaItem, BandejaStore } from './store.js';

export interface Releido {
  /** Lo que cambió, para decírselo («📅 trae la fecha del evento»). */
  nuevo: string[];
  item: BandejaItem;
}

/** Las fichas de la página: receta (≥ 2 ingredientes) y evento. */
export function fichasDe(html: string): Pick<BandejaExtra, 'receta' | 'evento'> {
  const isHtml = /<html|<body|<head|<meta|<script/i.test(html.slice(0, 5000));
  if (!isHtml) return {};
  const receta = recipeFromHtml(html)?.ingredients.length ?? 0;
  const evento = eventFromHtml(html);
  return { ...(receta >= 2 ? { receta } : {}), ...(evento ? { evento } : {}) };
}

/**
 * Relee la página de una cosa y guarda lo que traiga. Si la página ya no abre, no cambia
 * nada (y lo dice). Si la página ya no trae receta o evento, se quitan (el botón no
 * llevaría a nada).
 */
export async function releerCosa(
  store: BandejaStore,
  item: BandejaItem,
  fetchPagina: (url: string) => Promise<string>,
  now: Date = new Date(),
): Promise<Releido | string> {
  if (!item.url || !/^https?:\/\//i.test(item.url))
    return `#${item.id} no tiene una página que releer (es ${item.fileId ? 'un archivo' : 'una nota'}).`;
  let html: string;
  try {
    html = await fetchPagina(item.url);
  } catch (err) {
    return `🔄 No pude abrir la página de #${item.id} (${String(err instanceof Error ? err.message : err).slice(0, 100)}). No cambio nada.`;
  }
  const f = fichasDe(html);
  const { receta: _r, evento: _e, ...resto } = item.extra;
  const extra: BandejaExtra = { ...resto, ...f, releidaAt: now.toISOString() };
  const nuevo: string[] = [];
  if (f.receta && !item.extra.receta) nuevo.push(`🛒 es una receta (${f.receta} ingredientes)`);
  if (f.evento && !item.extra.evento) nuevo.push(`📅 es un evento: «${f.evento.nombre}»`);
  if (f.evento && item.extra.evento && f.evento.inicio !== item.extra.evento.inicio)
    nuevo.push('📅 ha cambiado la fecha del evento');
  store.setExtra(item.id, extra);
  return { nuevo, item: store.get(item.id) ?? { ...item, extra } };
}

/** Días hacia atrás que mira «/bandeja releer todo» (por defecto) y su tope. */
export const RELEER_TODO_DIAS = 30;
export const RELEER_TODO_MAX_DIAS = 90;
/** Páginas como mucho por cada «/bandeja releer todo» (lo demás, en la siguiente). */
export const RELEER_TODO_MAX = 20;
/** Pausa entre página y página: de una en una y sin prisa (no es un rastreador). */
export const RELEER_TODO_PAUSA_MS = 3000;

export interface ReleerTodoOpts {
  now: Date;
  dias?: number;
  max?: number;
  pausaMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Un aviso al empezar («🔄 Releo 12 páginas…»). */
  progress?: (text: string) => Promise<unknown>;
}

export interface ReleerTodoResult {
  /** Las que trajeron receta o evento nuevos (o un evento con otra fecha). */
  nuevas: Releido[];
  /** Releídas sin nada nuevo. */
  igual: number;
  /** No abrieron (se reintentan en la siguiente: no se marcan). */
  fallidas: number;
  /** Las que quedan para otra vez (pasaban del tope). */
  quedan: number;
  /** Ninguna que releer (todas releídas ya, o nada en esos días). */
  total: number;
}

const enCurso = new Set<string>();

/** Lo que mira «/bandeja releer todo»: enlaces de esos días aún sin releer ni con 🛒/📅. */
export function pendientesDeReleer(
  store: BandejaStore,
  chatId: string,
  now: Date,
  dias = RELEER_TODO_DIAS,
): BandejaItem[] {
  const desde = new Date(now.getTime() - dias * 86_400_000).toISOString();
  return store
    .pagesSince(chatId, desde)
    .filter((it) => it.url && /^https?:\/\//i.test(it.url))
    .filter((it) => !it.extra.releidaAt && !it.extra.receta && !it.extra.evento);
}

/**
 * «/bandeja releer todo»: relee de una en una (con pausa) las páginas guardadas en los
 * últimos `dias` que aún no se releyeron, hasta `max` por vez. Una sola pasada a la vez por
 * chat. Lo que no abre no se marca y entra en la siguiente.
 */
export async function releerTodo(
  store: BandejaStore,
  chatId: string,
  fetchPagina: (url: string) => Promise<string>,
  opts: ReleerTodoOpts,
): Promise<ReleerTodoResult | 'ocupado'> {
  if (enCurso.has(chatId)) return 'ocupado';
  enCurso.add(chatId);
  try {
    const max = opts.max ?? RELEER_TODO_MAX;
    const pausa = opts.pausaMs ?? RELEER_TODO_PAUSA_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const todas = pendientesDeReleer(store, chatId, opts.now, opts.dias);
    const lote = todas.slice(0, max);
    const out: ReleerTodoResult = {
      nuevas: [],
      igual: 0,
      fallidas: 0,
      quedan: todas.length - lote.length,
      total: todas.length,
    };
    if (!lote.length) return out;
    const segs = Math.round(((lote.length - 1) * pausa) / 1000);
    await opts
      .progress?.(
        `🔄 Releo ${lote.length === 1 ? '1 página' : `${lote.length} páginas`} de una en una${segs >= 10 ? ` (~${segs < 90 ? `${segs} s` : `${Math.round(segs / 60)} min`})` : ''}. Te digo qué traen.`,
      )
      .catch(() => undefined);
    for (const [i, it] of lote.entries()) {
      if (i > 0 && pausa > 0) await sleep(pausa);
      const r = await releerCosa(store, it, fetchPagina, opts.now);
      if (typeof r === 'string') out.fallidas++;
      else if (r.nuevo.length) out.nuevas.push(r);
      else out.igual++;
    }
    return out;
  } finally {
    enCurso.delete(chatId);
  }
}
