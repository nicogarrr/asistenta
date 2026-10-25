// Recomendaciones TMDB al estilo free-my-tv: lo que triunfa esta semana +
// novedades recientes, filtrado a las apps de streaming que Nico tiene en la TV
// y a su región (ES). Tres picks por franja ("Para esta mañana/tarde/noche").
//
// La clave TMDB es personal y gratuita (themoviedb.org → Settings → API) y se
// introduce en Ajustes en la propia TV; vive solo en localStorage. Sin clave la
// fila de recomendaciones simplemente no aparece. La clave nunca va al log.

const API = 'https://api.themoviedb.org/3';
// w780 (no 'original'): pósters grandes disparan la RAM de una TV con 2 GB.
const IMG = 'https://image.tmdb.org/t/p/w780';
// Servicios que Nico más usa y que SÍ son proveedores TMDB: sus títulos van
// primero en "Para ti". Nuvio no es proveedor de TMDB (es un reproductor
// agregador), así que no podemos saber su catálogo ni priorizarlo — antes que
// inventar disponibilidad, no aparece como proveedor en las tarjetas.
const PREFERRED_APP_IDS = ['netflix', 'com.movistarplus.es.iptv'];

const CACHE_KEY = 'tmdb-picks-v2';
const CACHE_MS = 6 * 3600_000;   // lista completa se recalcula cada 6 h

export interface Pick {
	id: number;
	kind: 'movie' | 'tv';
	title: string;
	backdrop: string;        // URL completa w780
	providerAppId: string;   // appId webOS a lanzar (futuro: OK sobre la tarjeta)
	providerName: string;
}

import {periodAt, type Period} from '../lib/greeting';
export type {Period};

export const periodFor = periodAt;

export const PERIOD_LABEL: Record<Period, string> = {
	manana: 'PARA ESTA MAÑANA',
	tarde: 'PARA ESTA TARDE',
	noche: 'PARA ESTA NOCHE'
};

// Nombre del proveedor en TMDB (minúsculas, por fragmento) → app de la TV.
// Los appId marcados en apps.ts como VERIFICAR se confirman en la fase 2.
const PROVIDER_MATCH: Array<{frag: string; appId: string; name: string}> = [
	{frag: 'netflix', appId: 'netflix', name: 'Netflix'},
	{frag: 'amazon', appId: 'amazon', name: 'Prime Video'},
	{frag: 'disney', appId: 'com.disney.disneyplus-prod', name: 'Disney+'},
	{frag: 'max', appId: 'com.wbd.stream', name: 'Max'},
	{frag: 'hbo', appId: 'com.wbd.stream', name: 'Max'},
	{frag: 'movistar', appId: 'com.movistarplus.es.iptv', name: 'Movistar Plus+'},
	{frag: 'skyshowtime', appId: 'com.skyshowtime.webos', name: 'SkyShowtime'},
	{frag: 'apple tv', appId: 'com.apple.appletv', name: 'Apple TV'}
];

interface Cache { ts: number; picks: Pick[] }

function loadCache (): Cache | null {
	try {
		const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Cache | null;
		if (c && Array.isArray(c.picks) && Date.now() - c.ts < CACHE_MS) return c;
	} catch { /* noop */ }
	return null;
}

function saveCache (picks: Pick[]): void {
	try { localStorage.setItem(CACHE_KEY, JSON.stringify({ts: Date.now(), picks})); } catch { /* noop */ }
}

function authHeaders (key: string): Record<string, string> {
	// Soporta tanto el Read Access Token (Bearer) como la API Key v3 (se pasa
	// como query param en get()).
	return key.length > 64 ? {Authorization: `Bearer ${key}`} : {};
}

function get (path: string, key: string): Promise<any> {
	const sep = path.includes('?') ? '&' : '?';
	const q = key.length > 64 ? '' : `${sep}api_key=${encodeURIComponent(key)}`;
	return fetch(`${API}${path}${q}`, {headers: authHeaders(key)})
		.then((r) => { if (!r.ok) throw new Error(`tmdb ${r.status}`); return r.json(); });
}

/** IDs de proveedores TMDB de las apps que Nico tiene (en su región). */
async function hisProviderIds (key: string, region: string): Promise<Map<number, {appId: string; name: string}>> {
	const d = await get(`/watch/providers/movie?watch_region=${region}`, key);
	const map = new Map<number, {appId: string; name: string}>();
	for (const p of d?.results || []) {
		const n = String(p.provider_name || '').toLowerCase();
		for (const m of PROVIDER_MATCH) {
			if (n.includes(m.frag)) { map.set(p.provider_id, {appId: m.appId, name: m.name}); break; }
		}
	}
	return map;
}

async function providersFor (kind: 'movie' | 'tv', id: number, key: string, region: string): Promise<number[]> {
	const d = await get(`/${kind}/${id}/watch/providers`, key);
	const flat = d?.results?.[region]?.flatrate || [];
	return flat.map((p: any) => p.provider_id as number);
}

function day (offset: number): string {
	return new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
}

/** Lista filtrada (cacheada 6 h). Devuelve [] sin clave o ante error. */
export async function fetchPicks (key: string, region: string): Promise<Pick[]> {
	if (!key.trim()) return [];
	const cached = loadCache();
	if (cached) return cached.picks;
	try {
		const providers = await hisProviderIds(key, region);
		if (!providers.size) return [];

		const out: Pick[] = [];
		for (const kind of ['movie', 'tv'] as const) {
			const hot = await get(`/trending/${kind}/week?language=es-ES`, key);
			const recent = kind === 'movie'
				? await get(`/discover/movie?vote_count.gte=30&primary_release_date.gte=${day(-365)}&primary_release_date.lte=${day(0)}&sort_by=popularity.desc&language=es-ES&watch_region=${region}`, key)
				: await get(`/discover/tv?vote_count.gte=20&air_date.gte=${day(-90)}&air_date.lte=${day(0)}&sort_by=popularity.desc&language=es-ES&watch_region=${region}`, key);
			const seen = new Set<number>();
			const cands = [...(hot?.results || []), ...(recent?.results || [])].filter((t) => {
				if (seen.has(t.id)) return false; seen.add(t.id); return true;
			}).slice(0, 14);
			for (const t of cands) {
				try {
					const ids = await providersFor(kind, t.id, key, region);
					const hit = ids.map((i) => providers.get(i)).find(Boolean);
					if (hit) {
						out.push({
							id: t.id, kind,
							title: String(t.title || t.name || ''),
							backdrop: t.backdrop_path ? `${IMG}${t.backdrop_path}` : '',
							providerAppId: hit.appId,
							providerName: hit.name
						});
					}
				} catch { /* un título que falla no frena a los demás */ }
			}
		}
		// Preferidos primero (sort estable: dentro de cada grupo manda TMDB).
		out.sort((a, b) => {
			const ra = PREFERRED_APP_IDS.indexOf(a.providerAppId);
			const rb = PREFERRED_APP_IDS.indexOf(b.providerAppId);
			return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
		});
		saveCache(out);
		return out;
	} catch {
		return [];
	}
}

/** 3 picks para la franja actual; rotan cada hora. */
export function picksForPeriod (all: Pick[], h: number): Pick[] {
	if (!all.length) return [];
	const start = (h * 3) % all.length;
	return [0, 1, 2].map((i) => all[(start + i) % all.length]);
}
