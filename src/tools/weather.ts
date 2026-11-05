import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  fetchWeatherDays,
  fetchWeatherLine,
  type WeatherConfig,
  weatherCodeEs,
} from '../briefing-daily.js';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';

const Params = lazySchema(() =>
  Type.Object({
    dias: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 7, description: 'Días de previsión desde hoy (1-7).' }),
    ),
    horas: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 48,
        description:
          'Previsión hora a hora para las próximas N horas (1-48), con cuándo empieza y para la lluvia. Para «¿llueve esta tarde?», «¿a qué hora para de llover?», «¿saco paraguas ahora?».',
      }),
    ),
    lugar: Type.Optional(
      Type.String({
        maxLength: 80,
        description:
          'Ciudad o pueblo si pregunta por otro sitio («Madrid», «Oviedo, Asturias», «París, Francia»). Vacío = el sitio configurado.',
      }),
    ),
    lat: Type.Optional(
      Type.Number({
        minimum: -90,
        maximum: 90,
        description: 'Latitud de una ubicación que compartió (junto con lon).',
      }),
    ),
    lon: Type.Optional(
      Type.Number({
        minimum: -180,
        maximum: 180,
        description: 'Longitud de una ubicación que compartió (junto con lat).',
      }),
    ),
  }),
);

const NO_PLACE =
  'No tengo configurado el sitio para el tiempo: pon PA_BRIEFING_LAT y PA_BRIEFING_LON en .env (y PA_BRIEFING_PLACE para el nombre). Mientras, puedo darte el de una ciudad concreta si me la dices.';

/** Sin tildes ni mayúsculas, para comparar «Asturias» con «asturias» o «Principado de Asturias». */
const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

interface GeoHit {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
}

const GEO_CACHE_MAX = 64;
const geoCache = new Map<string, WeatherConfig | null>();

/**
 * Coordenadas de un sitio por su nombre con el buscador gratuito de Open-Meteo (sin clave).
 * «Oviedo, Asturias»: busca «Oviedo» y se queda con el resultado cuya región o país casa con
 * «Asturias». Sin pista, prefiere España (Nico vive aquí) y si no, el primero. null si no hay.
 */
export async function geocodePlace(
  place: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<WeatherConfig | null> {
  const [rawName = '', ...rest] = place.split(',');
  const name = rawName.trim();
  const hint = fold(rest.join(','));
  if (!name) return null;
  const key = `${fold(name)}|${hint}`;
  if (geoCache.has(key)) return geoCache.get(key) ?? null;
  const url =
    'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(name)}&count=10&language=es&format=json`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`el buscador de sitios ha respondido ${res.status}`);
  const body = (await res.json()) as { results?: GeoHit[] };
  const hits = (body.results ?? []).filter(
    (h) => typeof h.latitude === 'number' && typeof h.longitude === 'number',
  );
  const matches = (h: GeoHit): boolean =>
    (typeof h.country_code === 'string' && fold(h.country_code) === hint) ||
    [h.admin1, h.admin2, h.country]
      .filter((x): x is string => typeof x === 'string' && x.length >= 3)
      .some((x) => fold(x).includes(hint) || hint.includes(fold(x)));
  const hit = hint ? hits.find(matches) : (hits.find((h) => h.country_code === 'ES') ?? hits[0]);
  const out: WeatherConfig | null = hit
    ? {
        latitude: hit.latitude as number,
        longitude: hit.longitude as number,
        label: [hit.name ?? name, hit.country_code === 'ES' ? hit.admin1 : hit.country]
          .filter(Boolean)
          .join(', '),
      }
    : null;
  if (geoCache.size >= GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value as string);
  geoCache.set(key, out);
  return out;
}

const dayName = (date: string, i: number): string => {
  if (i === 0) return 'hoy';
  if (i === 1) return 'mañana';
  const at = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return `día ${i + 1}`;
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
};

export interface WeatherHour {
  /** Hora local del sitio, «2026-11-05T14:00». */
  time: string;
  temp: number;
  /** Probabilidad de lluvia en %, si la hay. */
  rainProb?: number;
  /** Lluvia prevista en mm, si la hay. */
  rainMm?: number;
  code?: number;
}

/** Previsión hora a hora desde la hora actual (Open-Meteo, hora local del sitio). */
export async function fetchWeatherHours(
  cfg: WeatherConfig,
  hours: number,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<WeatherHour[]> {
  const n = Math.min(48, Math.max(1, Math.round(hours) || 1));
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${cfg.latitude}&longitude=${cfg.longitude}` +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code' +
    `&timezone=auto&forecast_hours=${n}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`el servicio del tiempo ha respondido ${res.status}`);
  const body = (await res.json()) as {
    hourly?: {
      time?: string[];
      temperature_2m?: Array<number | null>;
      precipitation_probability?: Array<number | null>;
      precipitation?: Array<number | null>;
      weather_code?: Array<number | null>;
    };
  };
  const h = body.hourly;
  const out: WeatherHour[] = [];
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  for (let i = 0; i < Math.min(n, h?.time?.length ?? 0); i++) {
    const temp = num(h?.temperature_2m?.[i]);
    const time = h?.time?.[i];
    if (temp === undefined || typeof time !== 'string') continue;
    out.push({
      time,
      temp,
      rainProb: num(h?.precipitation_probability?.[i]),
      rainMm: num(h?.precipitation?.[i]),
      code: num(h?.weather_code?.[i]),
    });
  }
  return out;
}

/** ¿Llueve esa hora? Probabilidad alta o lluvia medible. */
const rainy = (h: WeatherHour): boolean => (h.rainProb ?? 0) >= 50 || (h.rainMm ?? 0) >= 0.2;

const mm = (n: number): string =>
  new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n);

/** Un tramo seguido de horas con lluvia probable. */
export interface RainSpan {
  start: WeatherHour;
  last: WeatherHour;
  /** Probabilidad máxima del tramo, en %. */
  peak: number;
}

/** Tramos seguidos de horas con lluvia, en orden. */
export function rainSpans(hours: readonly WeatherHour[]): RainSpan[] {
  const out: RainSpan[] = [];
  let cur: RainSpan | undefined;
  for (const h of hours) {
    if (rainy(h)) {
      if (cur) {
        cur.last = h;
        cur.peak = Math.max(cur.peak, h.rainProb ?? 0);
      } else cur = { start: h, last: h, peak: h.rainProb ?? 0 };
    } else if (cur) {
      out.push(cur);
      cur = undefined;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** La hora en que acaba un tramo («18:00»): la siguiente a su última hora con lluvia. */
const spanEnd = (last: WeatherHour): string =>
  `${String((Number(last.time.slice(11, 13)) + 1) % 24).padStart(2, '0')}:00`;

/**
 * Para el resumen de la mañana: «lluvia probable de 15:00 a 18:00» con las horas que quedan
 * de HOY (las de mañana no). Como mucho dos tramos, para que quepa en una línea; vacío si
 * no se espera lluvia.
 */
export function rainTodayText(hours: readonly WeatherHour[]): string {
  const today = hours[0]?.time.slice(0, 10);
  if (!today) return '';
  const spans = rainSpans(hours.filter((h) => h.time.slice(0, 10) === today));
  if (spans.length === 0) return '';
  const parts = spans.slice(0, 2).map((sp) => {
    const end = spanEnd(sp.last);
    return end === '00:00'
      ? `desde las ${sp.start.time.slice(11, 16)} hasta la noche`
      : `de ${sp.start.time.slice(11, 16)} a ${end}`;
  });
  return `lluvia probable ${parts.join(' y ')}${spans.length > 2 ? ' (y más tarde)' : ''}`;
}

/**
 * La línea del tiempo del resumen de la mañana: la del día («Tiempo en Gijón: 8–17 °C,
 * lluvia (60 %)») más, si se espera, cuándo llueve hoy («; lluvia probable de 15:00 a
 * 18:00.»). Las dos consultas van a la vez; si falla la de horas, queda la del día.
 */
export async function briefingWeatherLine(
  cfg: WeatherConfig,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const [line, hours] = await Promise.all([
    fetchWeatherLine(cfg, fetchFn),
    fetchWeatherHours(cfg, 24, fetchFn).catch((err: unknown) => {
      log.warn('tiempo: sin previsión por horas para el resumen', { err: String(err) });
      return [] as WeatherHour[];
    }),
  ]);
  if (!line) return null;
  const rain = rainTodayText(hours);
  return rain ? `${line}; ${rain}.` : line;
}

/**
 * El texto hora a hora: primero cuándo llueve (tramos), que es lo que se suele preguntar,
 * y luego cada hora (de 2 en 2 si son más de 24).
 */
export function hourlyText(hours: readonly WeatherHour[], label?: string): string {
  const today = hours[0]?.time.slice(0, 10) ?? '';
  const when = (t: string): string => {
    const day = t.slice(0, 10);
    const hh = t.slice(11, 16);
    if (day === today) return hh;
    // El día siguiente del calendario del sitio (aritmética de fechas, sin zona horaria).
    const at = new Date(`${today}T12:00:00Z`);
    at.setUTCDate(at.getUTCDate() + 1);
    const next = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
    return day === next ? `mañana ${hh}` : `${day.slice(8, 10)}/${day.slice(5, 7)} ${hh}`;
  };
  const spans = rainSpans(hours).map(
    (sp) => `de ${when(sp.start.time)} a ${spanEnd(sp.last)} (hasta ${Math.round(sp.peak)} %)`,
  );
  const head = `Tiempo hora a hora${label ? ` en ${label}` : ''} (próximas ${hours.length} h):`;
  const rain = spans.length
    ? `Lluvia probable ${spans.join('; ')}.`
    : `Sin lluvia prevista en las próximas ${hours.length} horas.`;
  const step = hours.length > 24 ? 2 : 1;
  const lines = hours
    .filter((_, i) => i % step === 0)
    .map((h) => {
      const parts = [`${Math.round(h.temp)} °C`];
      const sky = typeof h.code === 'number' ? weatherCodeEs(h.code) : '';
      if (sky) parts.push(sky);
      if ((h.rainProb ?? 0) >= 20)
        parts.push(
          `${Math.round(h.rainProb ?? 0)} % de lluvia${(h.rainMm ?? 0) >= 0.1 ? `, ${mm(h.rainMm ?? 0)} mm` : ''}`,
        );
      return `${when(h.time)}: ${parts.join(', ')}`;
    });
  return [head, rain, ...lines].join('\n');
}

/**
 * «¿Qué tiempo hace mañana?»: previsión del sitio configurado para el resumen diario
 * (Open-Meteo, gratis, sin clave). También de otra ciudad («¿llueve el sábado en Madrid?»,
 * con el buscador de sitios de Open-Meteo) o de una ubicación compartida (lat/lon). Solo
 * lectura: no recibe URL del modelo, así que la única salida a la red son esos dos servicios.
 */
export function createWeatherTool(
  config: () => WeatherConfig | null,
  fetchFn: typeof fetch = fetch,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'tiempo',
    label: 'El tiempo',
    description:
      'Weather forecast (today up to 7 days, or hour by hour with `horas` for «¿llueve esta tarde?», «¿a qué hora para de llover?»). Without arguments: the place configured in .env (PA_BRIEFING_LAT/LON). For another city or town pass `lugar` («Madrid», «Oviedo, Asturias»); for a location the user shared pass its `lat` and `lon`. Use for «qué tiempo hace», «¿llueve mañana en Madrid?», «¿hará frío el sábado en Londres?», «¿qué tiempo hace aquí?» after a shared location. Read-only.',
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        let cfg: WeatherConfig | null;
        const place = args.lugar?.trim();
        if (typeof args.lat === 'number' && typeof args.lon === 'number') {
          cfg = {
            latitude: args.lat,
            longitude: args.lon,
            label: place || 'la ubicación compartida',
          };
        } else if (place) {
          try {
            cfg = await geocodePlace(place, fetchFn);
          } catch (err) {
            log.warn('tiempo: fallo al buscar el sitio', { err: String(err) });
            return 'No pude consultar el tiempo ahora: el servicio no responde. Prueba en un rato.';
          }
          if (!cfg)
            return `No encuentro «${place}» en el mapa del tiempo. Dime la ciudad o el pueblo (si hay varios, con la provincia o el país: «Mérida, México»).`;
        } else {
          cfg = config();
        }
        if (!cfg) return NO_PLACE;
        if (typeof args.horas === 'number') {
          let hours: WeatherHour[];
          try {
            hours = await fetchWeatherHours(cfg, args.horas, fetchFn);
          } catch (err) {
            log.warn('tiempo: fallo al consultar por horas', { err: String(err) });
            return 'No pude consultar el tiempo ahora: el servicio no responde. Prueba en un rato.';
          }
          if (hours.length === 0) return 'El servicio del tiempo no ha devuelto datos ahora.';
          return hourlyText(hours, cfg.label);
        }
        let days: Awaited<ReturnType<typeof fetchWeatherDays>>;
        try {
          days = await fetchWeatherDays(cfg, args.dias ?? 3, fetchFn);
        } catch (err) {
          // El texto crudo («fetch failed», «HTTP 503») solo al registro: el modelo lo repetía.
          log.warn('tiempo: fallo al consultar', { err: String(err) });
          return 'No pude consultar el tiempo ahora: el servicio no responde. Prueba en un rato.';
        }
        if (days.length === 0) return 'El servicio del tiempo no ha devuelto datos ahora.';
        const lines = days.map((d, i) => `${dayName(d.date, d.offset ?? i)}: ${d.text}`);
        return `Tiempo${cfg.label ? ` en ${cfg.label}` : ''}:\n${lines.join('\n')}`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
