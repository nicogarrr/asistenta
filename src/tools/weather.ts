import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fetchWeatherDays, type WeatherConfig } from '../briefing-daily.js';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';

const Params = lazySchema(() =>
  Type.Object({
    dias: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 7, description: 'Días de previsión desde hoy (1-7).' }),
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
      'Weather forecast (today up to 7 days). Without arguments: the place configured in .env (PA_BRIEFING_LAT/LON). For another city or town pass `lugar` («Madrid», «Oviedo, Asturias»); for a location the user shared pass its `lat` and `lon`. Use for «qué tiempo hace», «¿llueve mañana en Madrid?», «¿hará frío el sábado en Londres?», «¿qué tiempo hace aquí?» after a shared location. Read-only.',
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
