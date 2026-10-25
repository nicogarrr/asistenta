import {createContext, useContext} from 'react';

// User-tunable options (QOL config GUI) — persisted in localStorage so nothing
// needs a code edit + redeploy. App.tsx owns the state; ConfigContext fans it
// out to the widgets and background.
export interface GeoLocation {
	name: string;
	latitude: number;
	longitude: number;
}

export interface HomeConfig {
	clock24: boolean;
	tempUnit: 'fahrenheit' | 'celsius';
	bgAnimated: boolean;
	bgDensity: 'low' | 'normal' | 'high';
	bgSpeed: 'slow' | 'normal' | 'fast';
	bgTheme: 'classic' | 'mono' | 'ember' | 'aurora';
	/** Weather location — user-settable in Settings, so the prebuilt app isn't
	 *  pinned to the placeholder. Defaults to Gijón (Nico). */
	location: GeoLocation;
	/** Nico — saludo personalizado. */
	userName: string;
	/** Tarjeta del tiempo en el Home (minimalismo: se puede quitar). */
	showWeather: boolean;
	/** Reloj analógico en el salvapantallas (el digital se queda). */
	analogClock: boolean;
	/** Desplazamiento anti-quemado OLED (±2 px de vez en cuando). */
	oledGuard: boolean;
	/** Recomendaciones TMDB ("Para esta mañana/tarde/noche"). La clave se mete
	 *  en Ajustes en la propia TV y vive solo en localStorage: nunca en git. */
	picksEnabled: boolean;
	tmdbKey: string;
	tmdbRegion: string;
	/** Salvapantallas con fotos de los picks (estilo free-my-tv): fundido entre
	 *  backdrops TMDB detrás del reloj. Sin picks, constelaciones como siempre. */
	ambientPhotos: boolean;
	/** 'ambient': el reloj de la app veto al salvapantallas de la TV.
	 *  'system': deja pasar el salvapantallas de webOS (kit de arte). */
	tvScreensaver: 'ambient' | 'system';
	/** Iconos reales leídos de la TV vía el servicio ROOT del Homebrew Channel
	 *  (OPT-IN, off por defecto; patrón Hearth). Sin él: iconos del paquete/monograma. */
	liveIcons: boolean;
}

export const APP_VERSION = '0.2.0-nico';

export const DEFAULT_CONFIG: HomeConfig = {
	clock24: true,
	tempUnit: 'celsius',
	bgAnimated: true,
	bgDensity: 'normal',
	bgSpeed: 'normal',
	bgTheme: 'classic',
	location: {name: 'Gijón', latitude: 43.5322, longitude: -5.6611},
	userName: 'Nico y Nai',
	showWeather: true,
	analogClock: true,
	oledGuard: true,
	picksEnabled: true,
	tmdbKey: '',
	tmdbRegion: 'ES',
	ambientPhotos: true,
	tvScreensaver: 'ambient',
	liveIcons: false
};

const KEY = 'home-config-v2';

// Defaults antiguos que se corrigen en migración: solo se pisa el valor si el
// guardado ES el default viejo (un valor elegido por el usuario nunca se toca).
const LEGACY_DEFAULTS = {userName: 'Nico'};
export function loadConfig (): HomeConfig {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {...DEFAULT_CONFIG};
		const stored = JSON.parse(raw) as Partial<HomeConfig>;
		if (stored.userName === LEGACY_DEFAULTS.userName) stored.userName = DEFAULT_CONFIG.userName;
		return {...DEFAULT_CONFIG, ...stored};
	} catch { return {...DEFAULT_CONFIG}; }
}

export function saveConfig (cfg: HomeConfig): void {
	try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

export const DENSITY_MULT: Record<HomeConfig['bgDensity'], number> = {low: 0.55, normal: 1, high: 1.5};
export const SPEED_MULT: Record<HomeConfig['bgSpeed'], number> = {slow: 0.5, normal: 1, fast: 1.8};

export const ConfigContext = createContext<HomeConfig>(DEFAULT_CONFIG);
export function useConfig (): HomeConfig {
	return useContext(ConfigContext);
}
