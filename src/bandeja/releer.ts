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
  const extra: BandejaExtra = { ...resto, ...f };
  const nuevo: string[] = [];
  if (f.receta && !item.extra.receta) nuevo.push(`🛒 es una receta (${f.receta} ingredientes)`);
  if (f.evento && !item.extra.evento) nuevo.push(`📅 es un evento: «${f.evento.nombre}»`);
  if (f.evento && item.extra.evento && f.evento.inicio !== item.extra.evento.inicio)
    nuevo.push('📅 ha cambiado la fecha del evento');
  store.setExtra(item.id, extra);
  return { nuevo, item: store.get(item.id) ?? { ...item, extra } };
}
