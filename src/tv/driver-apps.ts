/**
 * Apps en teles que no son LG (Roku, Samsung): de la orden («abre Prime
 * Video», «abre RTVE Play») al id de esa marca.
 *
 * Antes el driver solo conocía sus seis apps por el id de LG («amazon»,
 * «youtube.leanback.v4»), pero la orden llega con el nombre dicho («prime
 * video», «youtube»): «abre YouTube» en un Roku o una Samsung contestaba «No
 * sé abrir «youtube»», y cualquier app fuera de esas seis no se podía abrir.
 * Ahora: alias de siempre → id de la marca; si no, la lista REAL de apps
 * instaladas (Roku: ECP /query/apps; Samsung: ed.installedApp.get), guardada
 * por tele con app-cache.ts.
 */
import type { TvApp } from './app-cache.js';
import { APP_ALIASES, APP_NAMES, normalizeTvText, resolveAppId } from './apps.js';

/** «prime video» → «amazon», «youtube» → «youtube.leanback.v4»; un id ya de LG queda igual. */
export function lgAppIdFor(appId: string): string {
  const a = appId.trim();
  return APP_ALIASES[normalizeTvText(a)] ?? a;
}

/** La app instalada que encaja con lo pedido (por id, alias o título), o null. */
export function matchInstalledApp(appId: string, installed: readonly TvApp[]): TvApp | null {
  if (installed.length === 0) return null;
  const list = [...installed];
  const tries = [appId, APP_NAMES[lgAppIdFor(appId)]].filter((t): t is string => !!t?.trim());
  for (const t of tries) {
    const r = resolveAppId(t, list);
    if (r.how === 'raw') continue;
    const hit = list.find((a) => a.id === r.id);
    if (hit) return hit;
  }
  return null;
}

/** Nombres para el mensaje de «no la encuentro» (como mucho 8). */
export function installedNames(installed: readonly TvApp[]): string {
  const names = installed.map((a) => a.title).filter(Boolean);
  if (names.length === 0) return '';
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown}…` : shown;
}
