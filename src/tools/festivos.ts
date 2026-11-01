import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { localDay } from '../datecontext.js';
import { log } from '../log.js';

/**
 * «¿El lunes es festivo?», «¿qué puentes hay?»: festivos nacionales y de la comunidad
 * configurada (por defecto Asturias), de la API pública date.nager.at (gratis, sin clave).
 * Solo lectura: el modelo no da URL; la única salida a la red es ese servicio fijo.
 * Las fiestas locales del ayuntamiento (y los traslados que la API no trae) se añaden a
 * mano con PA_FESTIVOS_LOCALES.
 */

const API = 'https://date.nager.at/api/v3/PublicHolidays';
const CACHE_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;

/** Comunidades y ciudades autónomas (ISO 3166-2:ES) con su nombre para el chat. */
export const COMUNIDADES: Readonly<Record<string, string>> = {
  'ES-AN': 'Andalucía',
  'ES-AR': 'Aragón',
  'ES-AS': 'Asturias',
  'ES-CB': 'Cantabria',
  'ES-CE': 'Ceuta',
  'ES-CL': 'Castilla y León',
  'ES-CM': 'Castilla-La Mancha',
  'ES-CN': 'Canarias',
  'ES-CT': 'Cataluña',
  'ES-EX': 'Extremadura',
  'ES-GA': 'Galicia',
  'ES-IB': 'Baleares',
  'ES-MC': 'Murcia',
  'ES-MD': 'Madrid',
  'ES-ML': 'Melilla',
  'ES-NC': 'Navarra',
  'ES-PV': 'País Vasco',
  'ES-RI': 'La Rioja',
  'ES-VC': 'Comunidad Valenciana',
};

export const DEFAULT_COMUNIDAD = 'ES-AS';

/** PA_FESTIVOS_COMUNIDAD («ES-AS», «as»…); vacía = Asturias; desconocida = solo nacionales. */
export function comunidadFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.PA_FESTIVOS_COMUNIDAD ?? '').trim().toUpperCase();
  if (!raw) return DEFAULT_COMUNIDAD;
  const code = raw.startsWith('ES-') ? raw : `ES-${raw}`;
  return code in COMUNIDADES ? code : null;
}

export interface FestivoLocal {
  /** «MM-DD» (cada año) o «YYYY-MM-DD» (solo ese año). */
  when: string;
  name: string;
}

/** PA_FESTIVOS_LOCALES: «06-29=San Pedro, 2026-11-02=Todos los Santos (traslado)». */
export function festivosLocalesFromEnv(env: NodeJS.ProcessEnv = process.env): FestivoLocal[] {
  const out: FestivoLocal[] = [];
  for (const part of (env.PA_FESTIVOS_LOCALES ?? '').split(/[,;]/)) {
    const [when = '', ...rest] = part.split('=');
    const w = when.trim();
    if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(w)) continue;
    out.push({ when: w, name: rest.join('=').trim() || 'fiesta local' });
  }
  return out;
}

export interface Festivo {
  date: string;
  name: string;
  where: 'nacional' | 'comunidad' | 'local';
}

interface NagerHoliday {
  date?: unknown;
  localName?: unknown;
  global?: unknown;
  counties?: unknown;
}

/** Los festivos de la respuesta de date.nager.at que tocan a la comunidad dada. */
export function parseNager(body: unknown, comunidad: string | null): Festivo[] {
  if (!Array.isArray(body)) return [];
  const out: Festivo[] = [];
  for (const h of body as NagerHoliday[]) {
    if (typeof h?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) continue;
    const name = typeof h.localName === 'string' ? h.localName : 'festivo';
    if (h.global === true) out.push({ date: h.date, name, where: 'nacional' });
    else if (comunidad && Array.isArray(h.counties) && h.counties.includes(comunidad))
      out.push({ date: h.date, name, where: 'comunidad' });
  }
  return out;
}

const weekday = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();
/** «YYYY-MM-DD» de una fecha de calendario guardada a mediodía UTC (no es «hoy»). */
const calendarDay = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const addDays = (date: string, n: number): string =>
  calendarDay(new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS));

/** «lunes 2 de noviembre». */
export function fechaLarga(date: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
    .format(new Date(`${date}T12:00:00Z`))
    .replace(',', '');
}

/** Nota de puente de un festivo: fin de semana largo, o qué día coger. Nada si no hay. */
export function puenteDe(date: string, isOff: (d: string) => boolean): string | null {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return null;
  let from = date;
  let to = date;
  while (isOff(addDays(from, -1))) from = addDays(from, -1);
  while (isOff(addDays(to, 1))) to = addDays(to, 1);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  if (days >= 3)
    return `fin de semana largo: ${days} días, del ${fechaLarga(from)} al ${fechaLarga(to)}`;
  if (wd === 2 && !isOff(addDays(date, -1)))
    return `puente si coges el ${fechaLarga(addDays(date, -1))}`;
  if (wd === 4 && !isOff(addDays(date, 1)))
    return `puente si coges el ${fechaLarga(addDays(date, 1))}`;
  return null;
}

const Params = Type.Object({
  fecha: Type.Optional(
    Type.String({
      description:
        'A date to check, YYYY-MM-DD (work it out from the <now> block: «el lunes» → next Monday).',
    }),
  ),
  puentes: Type.Optional(
    Type.Boolean({
      description: 'true: list the coming puentes and long weekends (next 12 months).',
    }),
  ),
});

export interface FestivosDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

const DOWN = 'No pude consultar los festivos ahora: el servicio no responde. Prueba en un rato.';

export function createFestivosTool(deps: FestivosDeps = {}): AgentTool<typeof Params> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<number, { at: number; body: unknown }>();

  const yearBody = async (year: number): Promise<unknown> => {
    const hit = cache.get(year);
    if (hit && now().getTime() - hit.at < CACHE_MS) return hit.body;
    const res = await fetchFn(`${API}/${year}/ES`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    cache.set(year, { at: now().getTime(), body });
    return body;
  };

  const holidays = async (years: number[], comunidad: string | null): Promise<Festivo[]> => {
    const locales = festivosLocalesFromEnv(deps.env);
    const out: Festivo[] = [];
    for (const year of years) {
      out.push(...parseNager(await yearBody(year), comunidad));
      for (const l of locales) {
        const date = l.when.length === 5 ? `${year}-${l.when}` : l.when;
        if (date.startsWith(String(year))) out.push({ date, name: l.name, where: 'local' });
      }
    }
    // Un mismo día puede salir dos veces (nacional y traslado local): se queda el primero.
    const byDate = new Map<string, Festivo>();
    for (const f of out.sort((a, b) => a.date.localeCompare(b.date)))
      if (!byDate.has(f.date)) byDate.set(f.date, f);
    return [...byDate.values()];
  };

  return {
    name: 'festivos',
    label: 'Festivos',
    description:
      'Spanish public holidays (national + the owner’s region, PA_FESTIVOS_COMUNIDAD, default Asturias; local ones from PA_FESTIVOS_LOCALES) from date.nager.at, no key. Use for «¿el lunes es festivo?», «¿cuándo es el próximo festivo?», «¿qué puentes hay?». Read-only.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        const env = deps.env ?? process.env;
        const comunidad = comunidadFromEnv(env);
        const place = comunidad ? (COMUNIDADES[comunidad] ?? comunidad) : null;
        const unknownNote =
          comunidad === null
            ? '\n(No reconozco la comunidad de PA_FESTIVOS_COMUNIDAD: solo cuento los nacionales.)'
            : '';
        const today = localDay(now());
        const fecha = args.fecha?.trim();
        if (fecha !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fecha))
          return 'Necesito el día como AAAA-MM-DD para mirarlo.';
        // «2026-02-30» no es el 2 de marzo, y «2026-13-01» no es nada: no se adivina.
        if (fecha !== undefined && calendarDay(new Date(`${fecha}T12:00:00Z`)) !== fecha)
          return `Esa fecha no existe (${fecha}). Dime el día como AAAA-MM-DD.`;
        const target = fecha ?? today;
        const year = Number(target.slice(0, 4));
        let list: Festivo[];
        try {
          list = await holidays([year, year + 1], comunidad);
        } catch (err) {
          log.warn('festivos: fallo al consultar', { err: String(err) });
          return DOWN;
        }
        const off = new Set(list.map((f) => f.date));
        const isOff = (d: string): boolean => off.has(d) || weekday(d) === 0 || weekday(d) === 6;
        const label = (f: Festivo): string =>
          f.where === 'nacional'
            ? `${f.name}, nacional`
            : f.where === 'local'
              ? `${f.name}, local`
              : `${f.name}, en ${place}`;
        const line = (f: Festivo): string => {
          const p = puenteDe(f.date, isOff);
          return `• ${fechaLarga(f.date)}: ${label(f)}${p ? ` (${p})` : ''}`;
        };

        if (fecha) {
          const hit = list.find((f) => f.date === fecha);
          if (hit) {
            const p = puenteDe(fecha, isOff);
            return `Sí: el ${fechaLarga(fecha)} es festivo (${label(hit)}).${p ? ` Es ${p}.` : ''}${unknownNote}`;
          }
          const wd = weekday(fecha);
          const next = list.find((f) => f.date > fecha);
          const why = wd === 0 || wd === 6 ? ' Es fin de semana, pero no festivo.' : '';
          return `No: el ${fechaLarga(fecha)} no es festivo${place ? ` en ${place}` : ''}.${why}${next ? ` El siguiente es el ${fechaLarga(next.date)} (${label(next)}).` : ''}${unknownNote}`;
        }

        const horizon = addDays(today, 365);
        const coming = list.filter((f) => f.date >= today && f.date <= horizon);
        if (args.puentes) {
          // Dos festivos del mismo finde largo (jueves y viernes santo) van en una sola línea.
          const grupos: { fs: Festivo[]; p: string }[] = [];
          for (const f of coming) {
            const p = puenteDe(f.date, isOff);
            if (!p) continue;
            const last = grupos.at(-1);
            if (last && last.p === p) last.fs.push(f);
            else grupos.push({ fs: [f], p });
          }
          const puentes = grupos.slice(0, 8);
          if (puentes.length === 0)
            return `No veo puentes en los próximos 12 meses${place ? ` en ${place}` : ''}.${unknownNote}`;
          const grupo = (g: { fs: Festivo[]; p: string }): string =>
            `• ${g.fs.map((f) => `${fechaLarga(f.date)}: ${label(f)}`).join('; ')} (${g.p})`;
          return `Puentes y findes largos${place ? ` en ${place}` : ''}:\n${puentes.map(grupo).join('\n')}${unknownNote}`;
        }
        if (coming.length === 0) return `No tengo festivos en los próximos meses.${unknownNote}`;
        return `Próximos festivos${place ? ` en ${place}` : ''}:\n${coming.slice(0, 5).map(line).join('\n')}${unknownNote}`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
