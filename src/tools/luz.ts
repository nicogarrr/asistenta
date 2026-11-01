import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Store } from '../db.js';
import { log } from '../log.js';

/**
 * «¿A qué hora pongo la lavadora?»: precio de la luz por horas (PVPC) de hoy o de mañana,
 * de la API pública de Red Eléctrica (apidatos.ree.es, gratis y sin clave). Solo lectura:
 * el modelo no da URL ni lugar, así que la única salida a la red es ese servicio fijo.
 * El aviso de cada noche es opcional (apagado por defecto): una rutina normal que el
 * dueño enciende o apaga con sus palabras («avísame cada noche de las horas baratas»).
 */

const REE_URL = 'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real';
const MADRID = 'Europe/Madrid';
const CACHE_MS = 30 * 60_000;
/** Horas que cuentan como «las más baratas» del día. */
const CHEAP_COUNT = 6;
/** Nombre de la rutina del aviso de cada noche (una por chat). */
export const LUZ_AVISO_ROUTINE = 'luz barata de mañana';
/** 21:00 cada día: Red Eléctrica publica los precios de mañana hacia las 20:30. */
export const LUZ_AVISO_SCHEDULE = '0 21 * * *';
const LUZ_AVISO_PROMPT =
  'Dime en dos o tres líneas las horas más baratas de la luz de mañana (herramienta luz, dia «mañana»). Si aún no están publicadas, dilo sin más.';

export interface LuzHour {
  /** Inicio de la hora (instante real). */
  at: Date;
  /** Precio en €/kWh. */
  price: number;
}

const Params = Type.Object({
  dia: Type.Optional(
    Type.Union([Type.Literal('hoy'), Type.Literal('mañana')], {
      description: 'Day: «hoy» (default) or «mañana» (published by Red Eléctrica around 20:30).',
    }),
  ),
  horas: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 8,
      description:
        'How many hours in a row the appliance needs (washing machine ≈ 2): finds the cheapest block.',
    }),
  ),
  aviso: Type.Optional(
    Type.Union([Type.Literal('activar'), Type.Literal('desactivar')], {
      description:
        'Only when the owner asks: turn on/off a nightly notice (21:00) with tomorrow’s cheap hours.',
    }),
  ),
});

export interface LuzDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** Para el aviso de cada noche (rutinas). Sin esto, el aviso no se ofrece. */
  store?: Pick<Store, 'saveRoutine' | 'deleteRoutine' | 'getRoutine'>;
  scopeOf?: () => string;
  sync?: () => void;
}

/** «2026-11-01» del día en Madrid (el mercado eléctrico va en hora peninsular). */
export function madridDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MADRID,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** «YYYY-MM-DD» de una fecha de calendario guardada a mediodía UTC (no es «hoy»). */
const calendarDay = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return calendarDay(d);
}

const hourOf = (at: Date): string =>
  String(
    Number(
      new Intl.DateTimeFormat('es-ES', {
        timeZone: MADRID,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(at),
    ),
  );

/** «10–11 h», en hora de Madrid (los días de cambio de hora salen bien). */
function span(from: Date, hours = 1): string {
  return `${hourOf(from)}–${hourOf(new Date(from.getTime() + hours * 3_600_000))} h`;
}

/** 0.08363 → «0,084 €/kWh». */
export function euros(price: number): string {
  const v = Math.abs(price) < 0.0005 ? 0 : price;
  return `${v.toFixed(3).replace('.', ',')} €/kWh`;
}

function dayLabel(day: string, isToday: boolean): string {
  const name = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`));
  return `${isToday ? 'hoy' : 'mañana'}, ${name}`;
}

/** Lee la serie PVPC (€/MWh por hora) de la respuesta de Red Eléctrica. */
export function parseLuzHours(body: unknown): LuzHour[] {
  const included = (body as { included?: unknown })?.included;
  if (!Array.isArray(included)) return [];
  const pvpc = included.find(
    (i) =>
      (i as { type?: string; id?: string })?.type === 'PVPC' ||
      (i as { id?: string })?.id === '1001',
  ) as { attributes?: { values?: unknown } } | undefined;
  const values = pvpc?.attributes?.values;
  if (!Array.isArray(values)) return [];
  const out: LuzHour[] = [];
  for (const v of values) {
    const value = (v as { value?: unknown })?.value;
    const at = new Date(String((v as { datetime?: unknown })?.datetime ?? ''));
    if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(at.getTime()))
      continue;
    out.push({ at, price: value / 1000 });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Junta horas seguidas en tramos: [10,11,12,15] → «de 10 a 13 h y de 15 a 16 h». */
function ranges(hours: LuzHour[]): string {
  const sorted = [...hours].sort((a, b) => a.at.getTime() - b.at.getTime());
  const groups: LuzHour[][] = [];
  for (const h of sorted) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && h.at.getTime() - prev.at.getTime() === 3_600_000) last.push(h);
    else groups.push([h]);
  }
  const parts = groups.map((g) => {
    const first = g[0] as LuzHour;
    const end = new Date(first.at.getTime() + g.length * 3_600_000);
    return `de ${hourOf(first.at)} a ${hourOf(end)} h`;
  });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
}

/** El tramo de `n` horas seguidas más barato entre las horas dadas (en orden). */
export function cheapestBlock(hours: LuzHour[], n: number): { from: Date; avg: number } | null {
  let best: { from: Date; avg: number } | null = null;
  for (let i = 0; i + n <= hours.length; i++) {
    const block = hours.slice(i, i + n);
    const first = block[0] as LuzHour;
    const last = block.at(-1) as LuzHour;
    // Solo horas de verdad seguidas (sin huecos en los datos).
    if (last.at.getTime() - first.at.getTime() !== (n - 1) * 3_600_000) continue;
    const avg = block.reduce((s, h) => s + h.price, 0) / n;
    if (!best || avg < best.avg) best = { from: first.at, avg };
  }
  return best;
}

/** El texto para el chat: hora actual, más barata, más cara, tramos baratos y media. */
export function luzText(
  hours: LuzHour[],
  opts: { day: string; isToday: boolean; now: Date; horas?: number },
): string {
  const lines = [`Luz (PVPC) ${dayLabel(opts.day, opts.isToday)}:`];
  const nowMs = opts.now.getTime();
  if (opts.isToday) {
    const current = hours.find(
      (h) => nowMs >= h.at.getTime() && nowMs < h.at.getTime() + 3_600_000,
    );
    if (current) lines.push(`• Ahora (${span(current.at)}): ${euros(current.price)}`);
  }
  const byPrice = [...hours].sort((a, b) => a.price - b.price);
  const min = byPrice[0] as LuzHour;
  const max = byPrice.at(-1) as LuzHour;
  lines.push(
    `• La más barata: ${span(min.at)} (${euros(min.price)}); la más cara: ${span(max.at)} (${euros(max.price)})`,
  );
  lines.push(`• Horas más baratas: ${ranges(byPrice.slice(0, CHEAP_COUNT))}`);
  const avg = hours.reduce((s, h) => s + h.price, 0) / hours.length;
  lines.push(`• Media del día: ${euros(avg)}`);
  const n = opts.horas;
  if (n) {
    // Hoy solo cuenta lo que queda (desde la hora en curso); mañana, el día entero.
    const pool = opts.isToday ? hours.filter((h) => h.at.getTime() + 3_600_000 > nowMs) : hours;
    const block = cheapestBlock(pool, n);
    const what = n === 1 ? 'Para 1 hora' : `Para ${n} horas seguidas`;
    if (block) {
      lines.push(
        `• ${what}${opts.isToday ? ' (lo que queda de hoy)' : ''}: de ${hourOf(block.from)} a ${hourOf(new Date(block.from.getTime() + n * 3_600_000))} h, a ${euros(block.avg)} de media`,
      );
    } else {
      lines.push(
        `• ${what}: hoy ya no quedan tantas horas seguidas; pregúntame por mañana a partir de las 20:30.`,
      );
    }
  }
  return lines.join('\n');
}

const NOT_YET =
  'Red Eléctrica aún no ha publicado los precios de mañana: suele hacerlo hacia las 20:30. Pregúntamelo esta noche.';
const DOWN =
  'No pude consultar el precio de la luz ahora: el servicio de Red Eléctrica no responde. Prueba en un rato.';

class LuzUnavailable extends Error {}

export function createLuzTool(deps: LuzDeps = {}): AgentTool<typeof Params> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; hours: LuzHour[] }>();

  const load = async (day: string): Promise<LuzHour[]> => {
    const hit = cache.get(day);
    if (hit && now().getTime() - hit.at < CACHE_MS) return hit.hours;
    const url = `${REE_URL}?start_date=${day}T00:00&end_date=${day}T23:59&time_trunc=hour`;
    const res = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 12_000),
    });
    // Red Eléctrica responde 502 «datos no disponibles» mientras no publica un día.
    if (!res.ok) throw new LuzUnavailable(`HTTP ${res.status}`);
    const hours = parseLuzHours(await res.json());
    if (hours.length > 0) cache.set(day, { at: now().getTime(), hours });
    return hours;
  };

  const aviso = (mode: 'activar' | 'desactivar'): string => {
    const { store, scopeOf } = deps;
    if (!store || !scopeOf) return 'El aviso de cada noche no está disponible aquí.';
    const scope = scopeOf();
    if (mode === 'desactivar') {
      if (!store.getRoutine(scope, LUZ_AVISO_ROUTINE))
        return 'No tenías puesto el aviso de la luz.';
      store.deleteRoutine(scope, LUZ_AVISO_ROUTINE);
      deps.sync?.();
      return 'Hecho: ya no te aviso cada noche de las horas baratas de la luz.';
    }
    store.saveRoutine({
      scope,
      name: LUZ_AVISO_ROUTINE,
      kind: 'schedule',
      prompt: LUZ_AVISO_PROMPT,
      schedule: LUZ_AVISO_SCHEDULE,
      enabled: true,
    });
    deps.sync?.();
    return 'Hecho: cada noche a las 21:00 te digo las horas más baratas de la luz de mañana. Para quitarlo, dime «quita el aviso de la luz».';
  };

  return {
    name: 'luz',
    label: 'Precio de la luz',
    description:
      'Spanish electricity price by hour (PVPC, Red Eléctrica, no key) for today or tomorrow: cheapest/most expensive hours, the price now and the cheapest block of N hours in a row. Use for «¿a qué hora pongo la lavadora?», «¿cuándo está barata la luz?», «precio de la luz mañana». Read-only. aviso=activar/desactivar only when the owner asks for (or to stop) a nightly notice.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        if (args.aviso) return aviso(args.aviso);
        const at = now();
        const today = madridDay(at);
        const isToday = args.dia !== 'mañana';
        const day = isToday ? today : nextDay(today);
        let hours: LuzHour[];
        try {
          hours = await load(day);
        } catch (err) {
          // El error crudo («HTTP 502», «fetch failed») solo al registro.
          log.warn('luz: fallo al consultar', { err: String(err) });
          return !isToday && err instanceof LuzUnavailable ? NOT_YET : DOWN;
        }
        if (hours.length === 0) return isToday ? DOWN : NOT_YET;
        return luzText(hours, { day, isToday, now: at, horas: args.horas });
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
