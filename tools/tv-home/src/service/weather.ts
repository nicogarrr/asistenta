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
				hours.push({
					hour: parseInt(hTimes[i].slice(11, 13), 10),
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
