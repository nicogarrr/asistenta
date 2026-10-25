// Weather via Open-Meteo — no API key. Placeholder location; set your own below.
export const LOCATION = {
	name: 'Gijón',
	latitude: 43.5322,
	longitude: -5.6611,
	temperatureUnit: 'celsius' as 'fahrenheit' | 'celsius'
};

const WMO: Record<number, [string, string]> = {
	0: ['Despejado', '☀'], 1: ['Casi despejado', '🌤'], 2: ['Intervalos nubosos', '⛅'], 3: ['Nublado', '☁'],
	45: ['Niebla', '🌫'], 48: ['Niebla helada', '🌫'],
	51: ['Llovizna', '🌦'], 53: ['Llovizna', '🌦'], 55: ['Llovizna', '🌧'],
	61: ['Lluvia', '🌧'], 63: ['Lluvia', '🌧'], 65: ['Lluvia fuerte', '🌧'],
	71: ['Nieve', '🌨'], 73: ['Nieve', '🌨'], 75: ['Nevada fuerte', '❄'],
	80: ['Chubascos', '🌦'], 81: ['Chubascos', '🌧'], 82: ['Aguacero', '⛈'],
	95: ['Tormenta', '⛈'], 96: ['Tormenta', '⛈'], 99: ['Tormenta', '⛈']
};

export interface WeatherNow {
	temp: number; unit: string; label: string; glyph: string;
}
export interface ForecastHour { hour: number; temp: number; glyph: string }
export interface ForecastDay { label: string; hi: number; lo: number; glyph: string }
export interface Forecast { now: WeatherNow; hours: ForecastHour[]; days: ForecastDay[]; isDay: boolean; sunrise: string; sunset: string }

function wmo (code: number): [string, string] {
	return WMO[code] || ['—', '🌡'];
}

export interface GeoResult {
	name: string;
	latitude: number;
	longitude: number;
	/** "City, Region, Country" for the results list */
	label: string;
}

interface RawGeo {
	name: string; latitude: number; longitude: number;
	admin1?: string; country?: string;
}

/** City search via Open-Meteo's free geocoding API (no key). Returns [] for a
 *  blank query or on error, so callers can render "no matches" simply. */
export function searchCity (query: string): Promise<GeoResult[]> {
	const q = query.trim();
	if (!q) return Promise.resolve([]);
	const url = 'https://geocoding-api.open-meteo.com/v1/search' +
		`?name=${encodeURIComponent(q)}&count=6&language=es&format=json`;
	return fetch(url)
		.then((r) => { if (!r.ok) throw new Error(`geocode ${r.status}`); return r.json(); })
		.then((d) => ((d.results as RawGeo[] | undefined) || []).map((g) => ({
			name: g.name,
			latitude: g.latitude,
			longitude: g.longitude,
			label: [g.name, g.admin1, g.country].filter(Boolean).join(', ')
		})))
		.catch(() => []);
}

/** Current conditions + next 5 hours + 3-day outlook, one Open-Meteo call. */
export function fetchForecast (loc = LOCATION): Promise<Forecast> {
	const url = 'https://api.open-meteo.com/v1/forecast' +
		`?latitude=${loc.latitude}&longitude=${loc.longitude}` +
		'&current=temperature_2m,weather_code,is_day' +
		'&hourly=temperature_2m,weather_code' +
		'&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
		'&forecast_days=3&timezone=auto' +
		`&temperature_unit=${loc.temperatureUnit}`;
	return fetch(url)
		.then((r) => { if (!r.ok) throw new Error(`weather ${r.status}`); return r.json(); })
		.then((data) => {
			const cur = data.current || {};
			const [label, glyph] = wmo(cur.weather_code as number);
			const now: WeatherNow = {
				temp: Math.round(cur.temperature_2m),
				unit: loc.temperatureUnit === 'celsius' ? '°C' : '°F',
				label, glyph
			};

			// next 5 hours, starting after the current one (times are TV-local via timezone=auto)
			const hTimes: string[] = data.hourly?.time || [];
			const nowIso = cur.time as string;
			let start = hTimes.findIndex((t) => t > nowIso);
			if (start < 0) start = 0;
			const hours: ForecastHour[] = [];
			for (let i = start; i < Math.min(start + 5, hTimes.length); i++) {
				const t = hTimes[i];
				if (t === undefined) continue;
				hours.push({
					hour: parseInt(t.slice(11, 13), 10),
					temp: Math.round(data.hourly.temperature_2m[i]),
					glyph: wmo(data.hourly.weather_code[i])[1]
				});
			}

			const dTimes: string[] = data.daily?.time || [];
			const days: ForecastDay[] = dTimes.slice(0, 3).map((t, i) => ({
				// parse as local noon so the weekday never shifts across the date line
				label: i === 0 ? 'Hoy' : new Date(`${t}T12:00:00`).toLocaleDateString([], {weekday: 'short'}),
				hi: Math.round(data.daily.temperature_2m_max[i]),
				lo: Math.round(data.daily.temperature_2m_min[i]),
				glyph: wmo(data.daily.weather_code[i])[1]
			}));

			const isDay = (cur.is_day as number) !== 0;
			const sunrise = ((data.daily?.sunrise || [])[0] as string) || '';
			const sunset = ((data.daily?.sunset || [])[0] as string) || '';
			return {now, hours, days, isDay, sunrise, sunset};
		});
}

// ---- Caché de la última previsión buena (portado de Hearth, MIT: ver ../THIRD_PARTY_NOTICES.md) ----
// La home pinta el tiempo al instante desde la copia guardada y lo refresca en
// segundo plano: nunca espera a la red. Una lectura más vieja que SHOWN no se
// muestra (la TV lleva mucho apagada y el dato engaña).

export interface CachedForecast {
	/** cuándo se leyó (ms desde 1970) */
	at: number;
	/** ubicación+unidad a la que pertenece; no mostrar el tiempo de otra ciudad */
	key: string;
	forecast: Forecast;
}

export const FORECAST_CACHE_KEY = 'home-forecast-v1';
/** Una lectura más reciente que esto no se vuelve a pedir. Igual al poll del widget. */
export const FORECAST_FRESH_MS = 15 * 60 * 1000;
/** Una lectura más vieja que esto ya no se muestra. */
export const FORECAST_SHOWN_MS = 6 * 60 * 60 * 1000;

/** Identidad de la lectura: coordenadas redondeadas + unidad. Cambiar de ciudad
 *  o de °C/°F invalida la copia guardada (los grados ya van redondeados en esa unidad). */
export function forecastCacheKey (loc: {latitude: number; longitude: number; temperatureUnit: string}): string {
	const r = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
	return `${r(loc.latitude)},${r(loc.longitude)}:${loc.temperatureUnit}`;
}

function isForecastShape (f: unknown): f is Forecast {
	const fc = f as Forecast;
	return !!fc && typeof fc === 'object'
		&& !!fc.now && typeof fc.now.temp === 'number' && typeof fc.now.glyph === 'string'
		&& Array.isArray(fc.hours) && Array.isArray(fc.days);
}

/** Lee la copia guardada. null si no hay, está corrupta o es más vieja que SHOWN. */
export function readForecastCache (storage: Pick<Storage, 'getItem'>, now: number): CachedForecast | null {
	try {
		const raw = storage.getItem(FORECAST_CACHE_KEY);
		if (!raw) return null;
		const c = JSON.parse(raw) as CachedForecast;
		if (!c || typeof c.at !== 'number' || typeof c.key !== 'string' || !isForecastShape(c.forecast)) return null;
		if (now - c.at > FORECAST_SHOWN_MS) return null;
		return c;
	} catch { return null; }
}

export function writeForecastCache (storage: Pick<Storage, 'setItem'>, key: string, forecast: Forecast, now: number): void {
	try { storage.setItem(FORECAST_CACHE_KEY, JSON.stringify({at: now, key, forecast} satisfies CachedForecast)); }
	catch { /* localStorage lleno o bloqueado: el tiempo simplemente no se cachea */ }
}

/** La copia guardada SOLO si es de esta ubicación+unidad y no está caducada. */
export function cachedForecastFor (
	storage: Pick<Storage, 'getItem'>,
	loc: {latitude: number; longitude: number; temperatureUnit: string},
	now: number
): Forecast | null {
	const c = readForecastCache(storage, now);
	return c && c.key === forecastCacheKey(loc) ? c.forecast : null;
}

/** Reintento tras un fallo de red: 2 → 10 → 30 min (patrón Hearth). `fails` es
 *  el número de fallos consecutivos (1 = primer fallo). */
export function forecastRetryDelayMs (fails: number): number {
	if (fails <= 1) return 2 * 60_000;
	if (fails === 2) return 10 * 60_000;
	return 30 * 60_000;
}

/** Como cachedForecastFor, pero devuelve tambien cuando se leyo (para marcarla como no actual). */
export function cachedReadingFor (
	storage: Pick<Storage, 'getItem'>,
	loc: {latitude: number; longitude: number; temperatureUnit: string},
	now: number
): {forecast: Forecast; at: number} | null {
	const c = readForecastCache(storage, now);
	return c && c.key === forecastCacheKey(loc) ? {forecast: c.forecast, at: c.at} : null;
}

/** Texto de antiguedad solo cuando la lectura ya no es "de ahora" (>2 ciclos de refresco). */
export function staleLabel (at: number, now: number): string | null {
	const age = now - at;
	if (age <= 2 * FORECAST_FRESH_MS) return null;
	const h = Math.floor(age / 3_600_000);
	return h >= 1 ? `hace ${h} h` : `hace ${Math.floor(age / 60_000)} min`;
}
