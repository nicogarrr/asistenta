/**
 * Vista única de vigilancias (paso P3 del plan de cohesión, versión de solo lectura).
 *
 * Cada tipo de vigilancia guarda su lista en su sitio: páginas y precios por URL en
 * `memory.db` (page_watches), el vigilante de precios por tienda en `pricewatch.json`,
 * las rutinas programadas y los disparadores en `agent.db`. Nadie podía responder de una
 * vez a «¿qué está vigilando Asistenta?».
 *
 * Este módulo NO cambia ninguna vigilancia ni su reloj: solo traduce cada lista a una
 * entrada común y la pinta en español. Los lectores son funciones puras sobre los datos
 * que ya devuelven los stores, para que se puedan probar sin abrir bases de datos.
 */

import type { Routine, RoutineTrigger } from '../db.js';
import type { PageWatch } from './pages.js';
import type { WatchConfig } from './pricewatch.js';

export type OverviewKind = 'pagina' | 'precio' | 'tiendas' | 'rutina' | 'disparador' | 'ojo';

export interface OverviewEntry {
  kind: OverviewKind;
  id: string;
  /** Lo que el usuario reconoce: etiqueta, nombre del producto o de la rutina. */
  label: string;
  /** URL, tiendas, cron o evento. */
  target: string;
  /** Chat (scope) al que pertenece; vacío = global. */
  scope: string;
  enabled: boolean;
  /** Última ejecución conocida (ms epoch); undefined = nunca o desconocido. */
  lastRunMs?: number;
  /** Detalle corto: objetivo de precio, cron, coincidencia… */
  detail?: string;
}

const KIND_ORDER: OverviewKind[] = ['pagina', 'precio', 'tiendas', 'rutina', 'disparador', 'ojo'];

const KIND_TITLE: Record<OverviewKind, string> = {
  pagina: 'Páginas vigiladas',
  precio: 'Precios por URL',
  tiendas: 'Vigilante de precios (pricewatch.json)',
  rutina: 'Rutinas programadas',
  disparador: 'Disparadores',
  ojo: 'Ojo de águila (avisos sin modelo)',
};

function euros(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function isoMs(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
}

/** page_watches: con objetivo de precio o bajada → «precio»; si no, «pagina». */
export function fromPageWatches(list: readonly PageWatch[]): OverviewEntry[] {
  return list.map((w) => {
    const priced = w.targetCents !== null || w.dropPct !== null;
    const bits: string[] = [];
    if (w.keyword) bits.push(`busca «${w.keyword}»`);
    if (w.targetCents !== null) bits.push(`objetivo ≤ ${euros(w.targetCents)}`);
    if (w.dropPct !== null) bits.push(`bajada ≥ ${w.dropPct}%`);
    if (w.failures > 0) bits.push(`${w.failures} fallos seguidos`);
    return {
      kind: priced ? 'precio' : 'pagina',
      id: w.id,
      label: w.label || w.url,
      target: w.url,
      scope: w.scope,
      enabled: w.active,
      lastRunMs: w.lastCheckedAt > 0 ? w.lastCheckedAt : undefined,
      detail: bits.length ? bits.join(', ') : undefined,
    };
  });
}

/** pricewatch.json: un producto por entrada, con sus tiendas. */
export function fromPriceConfig(cfg: WatchConfig | null): OverviewEntry[] {
  if (!cfg) return [];
  return cfg.products.map((p) => ({
    kind: 'tiendas' as const,
    id: p.name,
    label: p.label ?? p.name,
    target: Object.keys(p.urls).join(', '),
    scope: cfg.telegram.chatId,
    enabled: cfg.enabled,
  }));
}

/** Solo las rutinas con cron: las de tipo procedimiento no vigilan nada por sí solas. */
export function fromRoutines(list: readonly Routine[]): OverviewEntry[] {
  return list
    .filter((r) => r.kind === 'schedule' && r.schedule)
    .map((r) => ({
      kind: 'rutina' as const,
      id: r.id,
      label: r.name,
      target: r.schedule ?? '',
      scope: r.scope,
      enabled: r.enabled,
      lastRunMs: isoMs(r.lastRunAt),
    }));
}

export function fromTriggers(list: readonly RoutineTrigger[]): OverviewEntry[] {
  return list.map((t) => ({
    kind: 'disparador' as const,
    id: t.id,
    label: t.routine,
    target: t.event,
    scope: t.scope,
    enabled: t.enabled,
    lastRunMs: isoMs(t.lastFiredAt),
    detail: t.match ? `si contiene «${t.match}»` : undefined,
  }));
}

/** Filtra por chat (scope) si se da; las entradas globales (scope vacío) siempre entran. */
/** Interruptores del ojo de águila (vigilante.ts, ojo-screen.ts, ojo-downloads.ts). */
export interface OjoState {
  /** Interruptor general (`/ojo on|off`): encendido por defecto. */
  attention: boolean;
  /** `/ojo pantalla on|off`: apagado por defecto. */
  screen: boolean;
  /** `/ojo descargas on|off`: apagado por defecto. */
  downloads: boolean;
}

/**
 * Pantalla y descargas solo vigilan si además está encendido el interruptor general:
 * con el ojo apagado salen en pausa aunque su propio interruptor diga «on».
 */
export function fromOjo(s: OjoState): OverviewEntry[] {
  const off = s.attention ? undefined : 'el ojo general está apagado';
  return [
    {
      kind: 'ojo',
      id: 'ojo',
      label: 'Atención general',
      target: 'correo, cargos y eventos',
      scope: '',
      enabled: s.attention,
    },
    {
      kind: 'ojo',
      id: 'ojo:pantalla',
      label: 'Pantalla',
      target: 'avisos que aparecen en pantalla',
      scope: '',
      enabled: s.attention && s.screen,
      detail: s.screen ? off : undefined,
    },
    {
      kind: 'ojo',
      id: 'ojo:descargas',
      label: 'Descargas',
      target: 'ficheros nuevos en Descargas',
      scope: '',
      enabled: s.attention && s.downloads,
      detail: s.downloads ? off : undefined,
    },
  ];
}

export function forScope(entries: readonly OverviewEntry[], scope?: string): OverviewEntry[] {
  if (!scope) return [...entries];
  return entries.filter((e) => e.scope === scope || e.scope === '');
}

function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  const min = Math.round(d / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

/** Texto plano en español, agrupado por tipo; las pausadas se marcan. */
export function formatOverview(
  entries: readonly OverviewEntry[],
  now: number = Date.now(),
): string {
  if (entries.length === 0) return 'No hay ninguna vigilancia activa.';
  const lines: string[] = [];
  const active = entries.filter((e) => e.enabled).length;
  lines.push(
    `Vigilancias: ${entries.length} (${active} activas${active < entries.length ? `, ${entries.length - active} en pausa` : ''})`,
  );
  for (const kind of KIND_ORDER) {
    const group = entries.filter((e) => e.kind === kind);
    if (!group.length) continue;
    lines.push('', `${KIND_TITLE[kind]} (${group.length})`);
    for (const e of group) {
      const parts = [`• ${e.label}`];
      if (e.target && e.target !== e.label) parts.push(`— ${e.target}`);
      if (e.detail) parts.push(`(${e.detail})`);
      if (!e.enabled) parts.push('[en pausa]');
      if (e.kind !== 'ojo') {
        parts.push(e.lastRunMs ? `· última: ${ago(e.lastRunMs, now)}` : '· aún no se ha ejecutado');
      }
      lines.push(parts.join(' '));
    }
  }
  return lines.join('\n');
}
