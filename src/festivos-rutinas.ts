import { localDay } from './datecontext.js';
import { log } from './log.js';
import { foldAccents } from './text.js';
import {
  COMUNIDADES,
  comunidadFromEnv,
  FESTIVOS_API,
  fechaLarga,
  festivosLocalesFromEnv,
  parseNager,
  puenteDe,
} from './tools/festivos.js';

/**
 * «Excepto festivos» en rutinas y recordatorios: el cron sigue siendo el de siempre y,
 * al sonar, se mira si ese día es festivo (nacional, de la comunidad de
 * PA_FESTIVOS_COMUNIDAD y los locales de PA_FESTIVOS_LOCALES, los mismos datos que la
 * herramienta de festivos). Si lo es, ese día no suena y no se recupera otro día: el
 * siguiente aviso es el que ya tocaba.
 */

const SKIP =
  /\b(?:excepto|menos|salvo|quitando|sin contar|que no sean?|no) (?:en )?(?:el |los )?(?:dias? )?festivos?\b/;

const fold = (text: string): string => foldAccents(text).replace(/\s+/g, ' ');

/** ¿El texto pide saltarse los festivos («excepto festivos», «que no sea festivo»…)? */
export function skipsHolidays(text: string | null | undefined): boolean {
  return !!text && SKIP.test(fold(text));
}

/** El texto sin la coletilla de festivos, para leer el horario del resto. */
export function withoutSkipHolidays(text: string): string {
  return fold(text).replace(SKIP, ' ').replace(/\s+/g, ' ').trim();
}

/** «festivos nacionales y de Asturias», o solo nacionales si la comunidad no se reconoce. */
export function festivosQueCuentan(env: NodeJS.ProcessEnv = process.env): string {
  const comunidad = comunidadFromEnv(env);
  return comunidad
    ? `festivos nacionales y de ${COMUNIDADES[comunidad] ?? comunidad}`
    : 'festivos nacionales (no reconozco PA_FESTIVOS_COMUNIDAD)';
}

/** Domingo de Pascua (gregoriano), «MM-DD». */
function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Los nacionales de fecha fija y Viernes Santo: lo que se sabe sin red. */
export function nacionalesSinRed(year: number): string[] {
  const fixed = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];
  const { month, day } = easter(year);
  const goodFriday = new Date(Date.UTC(year, month - 1, day - 2));
  const gf = `${String(goodFriday.getUTCMonth() + 1).padStart(2, '0')}-${String(goodFriday.getUTCDate()).padStart(2, '0')}`;
  return [...fixed, gf].map((md) => `${year}-${md}`);
}

export interface HolidayCheckDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const CACHE_MS = 12 * 3_600_000;

/** Festivos de un año, fecha → nombre, con caché y la misma reserva sin red. */
function yearLoader(deps: HolidayCheckDeps): (year: number) => Promise<Map<string, string>> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<number, { at: number; days: Map<string, string> }>();
  let warnedComunidad = false;

  return async (year: number): Promise<Map<string, string>> => {
    const env = deps.env ?? process.env;
    const hit = cache.get(year);
    if (hit && now().getTime() - hit.at < CACHE_MS) return hit.days;
    const comunidad = comunidadFromEnv(env);
    if (comunidad === null && !warnedComunidad) {
      warnedComunidad = true;
      log.warn('festivos: no reconozco PA_FESTIVOS_COMUNIDAD, solo cuento los nacionales');
    }
    const locales: Array<[string, string]> = festivosLocalesFromEnv(env).map((l) => [
      l.when.length === 5 ? `${year}-${l.when}` : l.when,
      l.name,
    ]);
    try {
      const res = await fetchFn(`${FESTIVOS_API}/${year}/ES`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const listed = parseNager((await res.json()) as unknown, comunidad);
      if (listed.length === 0) throw new Error('respuesta vacía');
      const days = new Map<string, string>(locales);
      for (const f of listed) days.set(f.date, f.name);
      cache.set(year, { at: now().getTime(), days });
      return days;
    } catch (err) {
      log.warn('festivos: no pude consultarlos', { err: String(err) });
      if (hit) return hit.days;
      const days = new Map<string, string>(locales);
      for (const d of nacionalesSinRed(year)) days.set(d, 'festivo nacional');
      return days;
    }
  };
}

/**
 * `isHoliday("2026-12-08")`. Sin respuesta del servicio se usa lo último bueno y, si no
 * hay nada, los nacionales que se saben sin red: mejor saltar Navidad sin internet que
 * sonar, y un día normal nunca se toma por festivo.
 */
export function createHolidayCheck(deps: HolidayCheckDeps = {}): (day: string) => Promise<boolean> {
  const load = yearLoader(deps);
  return async (day: string): Promise<boolean> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    return (await load(Number(day.slice(0, 4)))).has(day);
  };
}

const DAY_MS = 86_400_000;
const shift = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekend = (day: string): boolean => {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
};

/**
 * Para el briefing: el primer festivo entre semana de los próximos 7 días, en una línea
 * («Festivo el martes 8 de diciembre (Inmaculada Concepción): puente si coges el lunes…»),
 * o null si no hay.
 */
export function createProximoFestivo(
  deps: HolidayCheckDeps = {},
): (from: Date) => Promise<string | null> {
  const load = yearLoader(deps);
  return async (from: Date): Promise<string | null> => {
    const today = localDay(from);
    const last = shift(today, 7);
    const days = new Map(await load(Number(today.slice(0, 4))));
    if (last.slice(0, 4) !== today.slice(0, 4))
      for (const [d, n] of await load(Number(last.slice(0, 4)))) days.set(d, n);
    const isOff = (d: string): boolean => days.has(d) || weekend(d);
    for (let k = 1; k <= 7; k++) {
      const day = shift(today, k);
      const name = days.get(day);
      if (!name || weekend(day)) continue;
      const puente = puenteDe(day, isOff);
      return `Festivo el ${fechaLarga(day)} (${name})${puente ? `: ${puente}` : ''}.`;
    }
    return null;
  };
}
