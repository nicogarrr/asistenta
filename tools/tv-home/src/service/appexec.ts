// Iconos reales y lista completa de apps via el servicio root del Homebrew Channel
// (patrón de rudra-avatar/Hearth, MIT: ver ../../THIRD_PARTY_NOTICES.md).
//
// CONTRATO DE PRIVILEGIO: todo este módulo es OPT-IN ("Iconos reales" en Ajustes,
// off por defecto). Solo entonces la app pide al servicio de hbchannel ejecutar
// comandos como root. Sin root o sin opt-in, tv-home funciona igual que antes
// (catálogo + monogramas). Los appIds NUNCA llegan al shell: los iconos se piden
// por índice y las rutas pasan SAFE_PATH + shellQuote.

import {lunaCall} from './luna';

export interface LaunchPointRoot {
	id: string;
	title: string;
	/** dónde está el icono en la TV; permite reencontrarlo en la caché */
	iconPath?: string;
	removable?: boolean;
}

interface ExecResponse { stdoutString?: string }

/** Las rutas de icono deben ser absolutas y sencillas. Cualquier otra cosa
 *  (comillas, espacios, controles, sintaxis shell) se salta, no se pasa al shell. */
export const SAFE_PATH = /^\/[A-Za-z0-9._\/+@-]+$/;

/** Solo se lee como root un icono (imagen) dentro de raices de apps/recursos de
 *  webOS, sin segmentos ".." y con extension de imagen: el icono lo declara el
 *  appinfo de CADA app instalada (dato no confiable), asi que "ruta sencilla" no
 *  basta para no leer ficheros arbitrarios como root. Raices NO verificadas en TV. */
export const ICON_ROOTS = ['/usr/palm/', '/media/developer/', '/media/cryptofs/', '/usr/share/', '/mnt/'];
export const ICON_MAX_BYTES = 262_144;
export function isReadableIconPath (p: string): boolean {
	return SAFE_PATH.test(p)
		&& !p.split('/').includes('..')
		&& ICON_ROOTS.some((root) => p.startsWith(root))
		&& /\.(png|jpe?g|webp)$/i.test(p);
}

/** Cita POSIX. Defensa en profundidad: las rutas además están validadas. */
export function shellQuote (value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Ejecuta un comando como root a través del servicio del Homebrew Channel. */
export function exec (command: string, timeoutMs = 8000): Promise<string> {
	return lunaCall<ExecResponse>('org.webosbrew.hbchannel.service', 'exec', {command}, timeoutMs)
		.then((r) => r.stdoutString || '');
}

/** Parsea la salida de `luna-send listLaunchPoints` (pura, testeable). */
export function parseLaunchPointsJson (out: string): LaunchPointRoot[] {
	try {
		const parsed = JSON.parse(out) as {launchPoints?: {id?: unknown; title?: unknown; largeIcon?: unknown; icon?: unknown; removable?: unknown}[]};
		return (parsed.launchPoints || [])
			.filter((p) => typeof p.id === 'string' && typeof p.title === 'string')
			.map((p) => ({
				id: p.id as string,
				title: p.title as string,
				iconPath: (typeof p.largeIcon === 'string' && p.largeIcon) || (typeof p.icon === 'string' && p.icon) || undefined,
				removable: typeof p.removable === 'boolean' ? p.removable : undefined
			}));
	} catch { return []; }
}

/** Lista launch points COMO ROOT: incluye rutas de icono y flag removable, que
 *  la llamada sin root (applicationManager directo) no devuelve. */
export function listLaunchPointsRoot (): Promise<LaunchPointRoot[]> {
	return exec("luna-send -n 1 luna://com.webos.applicationManager/listLaunchPoints '{}'", 10000)
		.then(parseLaunchPointsJson)
		.then((points) => { if (!points.length) throw new Error('sin launch points'); return points; });
}

/** Un solo round-trip para N iconos: "<índice> <base64>" por línea. Los índices
 *  —no los appIds— llegan al shell; busybox base64 no tiene -w, se quitan \n. */
export function buildIconScript (paths: string[]): string {
	return paths
		.map((p, i) => `printf '%d ' ${i}; [ -f ${shellQuote(p)} ] && [ "$(wc -c < ${shellQuote(p)})" -le ${ICON_MAX_BYTES} ] && base64 ${shellQuote(p)} 2>/dev/null | tr -d '\\n'; echo`)
		.join('; ');
}

/** Parsea la salida del script de iconos (pura, testeable). Líneas basura o
 *  índices fuera de rango se ignoran. */
export function parseIconOutput (out: string, count: number): Record<number, string> {
	const result: Record<number, string> = {};
	for (const line of out.split('\n')) {
		const m = /^(\d+) ([A-Za-z0-9+/=]+)$/.exec(line);
		if (!m || m[2].length > Math.ceil(ICON_MAX_BYTES / 3) * 4) continue;
		const idx = Number(m[1]);
		if (idx >= 0 && idx < count) result[idx] = `data:image/png;base64,${m[2]}`;
	}
	return result;
}

// ---- caché de iconos (ruta → data URI) en localStorage ----
export const ICON_CACHE_KEY = 'home-icon-cache-v1';

export function readIconCache (storage: Pick<Storage, 'getItem'>): Record<string, string> {
	try {
		const c = JSON.parse(storage.getItem(ICON_CACHE_KEY) || '{}') as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const k of Object.keys(c)) if (typeof c[k] === 'string') out[k] = c[k] as string;
		return out;
	} catch { return {}; }
}

/** Guarda SOLO los iconos de rutas aún instaladas, para no pasar la cuota. */
export function writeIconCache (storage: Pick<Storage, 'setItem'>, cache: Record<string, string>, keepPaths: string[]): void {
	try {
		const kept: Record<string, string> = {};
		for (const p of keepPaths) if (cache[p]) kept[p] = cache[p];
		storage.setItem(ICON_CACHE_KEY, JSON.stringify(kept));
	} catch { /* cuota: los iconos se repiden la próxima vez */ }
}

/** Iconos reales para las apps dadas: caché primero, un exec para las que falten.
 *  Rutas que no pasan SAFE_PATH se ignoran. Fallo de red/root → devuelve lo que haya. */
export function loadIcons (apps: {id: string; iconPath?: string}[], storage: Pick<Storage, 'getItem' | 'setItem'>): Promise<Record<string, string>> {
	const cache = readIconCache(storage);
	const result: Record<string, string> = {};
	const missing: {id: string; path: string}[] = [];
	for (const a of apps) {
		if (!a.iconPath || !isReadableIconPath(a.iconPath)) continue;
		if (cache[a.iconPath]) result[a.id] = cache[a.iconPath];
		else missing.push({id: a.id, path: a.iconPath});
	}
	if (!missing.length) return Promise.resolve(result);
	const paths = missing.map((m) => m.path);
	return exec(buildIconScript(paths), 15000).then((out) => {
		const parsed = parseIconOutput(out, missing.length);
		for (const k of Object.keys(parsed)) {
			const entry = missing[Number(k)];
			result[entry.id] = parsed[Number(k)];
			cache[entry.path] = parsed[Number(k)];
		}
		writeIconCache(storage, cache, apps.map((a) => a.iconPath).filter((p): p is string => !!p));
		return result;
	}).catch(() => result);
}

/** Revocar el opt-in: borra los iconos guardados. */
export function clearIconCache (storage: Pick<Storage, 'removeItem'>): void {
	try { storage.removeItem(ICON_CACHE_KEY); } catch { /* sin storage */ }
}
