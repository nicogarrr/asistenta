import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { WeatherConfig } from '../briefing-daily.js';
import { log } from '../log.js';

/**
 * «¿Cómo está el aire?» y «¿hay mucho polen?»: calidad del aire y polen del sitio del
 * resumen diario (PA_BRIEFING_LAT/LON; si no hay, Gijón), con la API de calidad del aire
 * de Open-Meteo (gratis y sin clave; datos del servicio europeo Copernicus CAMS). Solo
 * lectura: no recibe URL ni lugar del modelo, así que la única salida a la red es esa API.
 * El polen es un modelo europeo, orientativo: no son los recuentos de una estación.
 */

const API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const ZONE = 'Europe/Madrid';
const CACHE_MS = 30 * 60_000;
const DOWN = 'No pude consultar la calidad del aire ahora mismo. Prueba otra vez en un rato.';
/** Sin sitio configurado: Gijón. */
export const GIJON: WeatherConfig = { latitude: 43.5357, longitude: -5.6615, label: 'Gijón' };

/** Índice europeo de calidad del aire (EAQI) con los nombres oficiales en español. */
const BANDAS: [number, string][] = [
  [20, 'buena'],
  [40, 'razonablemente buena'],
  [60, 'regular'],
  [80, 'desfavorable'],
  [100, 'muy desfavorable'],
];
export const calidad = (aqi: number): string =>
  BANDAS.find(([max]) => aqi <= max)?.[1] ?? 'extremadamente desfavorable';

/** Pólenes y sus umbrales (granos/m³) de «moderado» y «alto», orientativos. */
const POLENES: { key: string; nombre: string; moderado: number; alto: number }[] = [
  { key: 'grass_pollen', nombre: 'gramíneas', moderado: 25, alto: 50 },
  { key: 'olive_pollen', nombre: 'olivo', moderado: 50, alto: 200 },
  { key: 'birch_pollen', nombre: 'abedul', moderado: 30, alto: 100 },
  { key: 'alder_pollen', nombre: 'aliso', moderado: 30, alto: 100 },
  { key: 'mugwort_pollen', nombre: 'artemisa', moderado: 15, alto: 30 },
  { key: 'ragweed_pollen', nombre: 'ambrosía', moderado: 10, alto: 30 },
];
const CURRENT = ['european_aqi', 'pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone'];
const HOURLY = ['european_aqi', ...POLENES.map((p) => p.key)];

const Params = Type.Object({});

interface Datos {
  current: Record<string, number | null | undefined>;
  time: string[];
  hourly: Record<string, (number | null)[]>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dec = (n: number): string => (Math.round(n * 10) / 10).toString().replace('.', ',');

/** «2026-11-01» en Madrid, para separar las horas de hoy y de mañana. */
const diaMadrid = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(d);

export function createAireTool(
  config: () => WeatherConfig | null,
  deps: { fetchFn?: typeof fetch; now?: () => Date; timeoutMs?: number } = {},
): AgentTool<typeof Params> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  let cache: { at: number; key: string; datos: Datos } | null = null;

  const leer = async (cfg: WeatherConfig): Promise<Datos> => {
    const key = `${cfg.latitude},${cfg.longitude}`;
    if (cache && cache.key === key && now().getTime() - cache.at < CACHE_MS) return cache.datos;
    const url = new URL(API);
    url.searchParams.set('latitude', String(cfg.latitude));
    url.searchParams.set('longitude', String(cfg.longitude));
    url.searchParams.set('current', CURRENT.join(','));
    url.searchParams.set('hourly', HOURLY.join(','));
    url.searchParams.set('timezone', ZONE);
    url.searchParams.set('forecast_days', '2');
    const res = await fetchFn(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as {
      current?: Record<string, unknown>;
      hourly?: Record<string, unknown>;
    };
    const time = Array.isArray(raw.hourly?.time) ? (raw.hourly.time as unknown[]).map(String) : [];
    if (!raw.current || time.length === 0) throw new Error('respuesta sin datos');
    const hourly: Record<string, (number | null)[]> = {};
    for (const k of HOURLY) {
      const v = raw.hourly?.[k];
      hourly[k] = Array.isArray(v) ? v.map(num) : [];
    }
    const current: Record<string, number | null> = {};
    for (const k of CURRENT) current[k] = num(raw.current[k]);
    const datos = { current, time, hourly };
    cache = { at: now().getTime(), key, datos };
    return datos;
  };

  /** El máximo de una serie en un día (con su hora), o null si no hay datos. */
  const maxDelDia = (d: Datos, key: string, dia: string, desde = '') => {
    let best: { v: number; hora: string } | null = null;
    d.time.forEach((t, i) => {
      if (!t.startsWith(dia) || (desde && t < desde)) return;
      const v = d.hourly[key]?.[i] ?? null;
      if (v !== null && (!best || v > best.v)) best = { v, hora: t.slice(11, 16) };
    });
    return best as { v: number; hora: string } | null;
  };

  const polen = (d: Datos, dia: string): string => {
    const altos: string[] = [];
    let alguno = false;
    let datos = false;
    for (const p of POLENES) {
      const m = maxDelDia(d, p.key, dia);
      if (!m) continue;
      datos = true;
      if (m.v >= 1) alguno = true;
      if (m.v >= p.moderado) altos.push(`${p.nombre} ${m.v >= p.alto ? 'alto' : 'moderado'}`);
    }
    if (!datos) return 'sin datos';
    if (altos.length > 0) return altos.join(', ');
    return alguno ? 'bajo' : 'nada';
  };

  return {
    name: 'aire',
    label: 'Calidad del aire y polen',
    description:
      'Air quality (European AQI, PM2.5, PM10, NO2, ozone) and pollen for today and tomorrow at the place configured in .env (PA_BRIEFING_LAT/LON, default Gijón), from Open-Meteo / Copernicus CAMS, no key. Use for «¿cómo está el aire?», «¿hay mucho polen?», «¿puedo salir a correr?» (air). Read-only. Only the configured place.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async () => {
      const cfg = config() ?? GIJON;
      const text = async (): Promise<string> => {
        let d: Datos;
        try {
          d = await leer(cfg);
        } catch (err) {
          log.warn('aire: fallo al consultar', { err: String(err) });
          return DOWN;
        }
        const at = now();
        const hoy = diaMadrid(at);
        const manana = diaMadrid(new Date(at.getTime() + 24 * 3600_000));
        const horaAhora = `${hoy}T${new Intl.DateTimeFormat('es-ES', { timeZone: ZONE, hour: '2-digit', hour12: false }).format(at)}:00`;
        const sitio = cfg.label ? ` en ${cfg.label}` : '';
        const lines: string[] = [];
        const aqi = d.current.european_aqi;
        if (aqi !== null && aqi !== undefined) {
          const partes = [
            ['PM2,5', d.current.pm2_5],
            ['PM10', d.current.pm10],
            ['NO₂', d.current.nitrogen_dioxide],
            ['ozono', d.current.ozone],
          ]
            .filter((x): x is [string, number] => typeof x[1] === 'number')
            .map(([n, v]) => `${n} ${dec(v)}`);
          lines.push(
            `Calidad del aire${sitio} ahora: ${calidad(aqi)} (índice europeo ${Math.round(aqi)}).${partes.length ? ` ${partes.join(' · ')} µg/m³.` : ''}`,
          );
        } else {
          lines.push(`Calidad del aire${sitio}: ahora mismo no hay dato.`);
        }
        const restoHoy = maxDelDia(d, 'european_aqi', hoy, horaAhora);
        const peorManana = maxDelDia(d, 'european_aqi', manana);
        const prev: string[] = [];
        if (restoHoy && aqi !== null && aqi !== undefined && calidad(restoHoy.v) !== calidad(aqi))
          prev.push(`hoy llega a ${calidad(restoHoy.v)} hacia las ${restoHoy.hora}`);
        if (peorManana) prev.push(`mañana, como mucho, ${calidad(peorManana.v)}`);
        if (prev.length > 0)
          lines.push(`${prev.join('; ').replace(/^./, (c) => c.toUpperCase())}.`);
        const pHoy = polen(d, hoy);
        const pManana = polen(d, manana);
        lines.push(
          pHoy === pManana
            ? `Polen hoy y mañana: ${pHoy}${pHoy === 'nada' ? ' (fuera de temporada)' : ''}.`
            : `Polen hoy: ${pHoy}; mañana: ${pManana}.`,
        );
        lines.push('(Datos de Copernicus; el polen es orientativo.)');
        return lines.join('\n');
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
