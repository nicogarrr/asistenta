import type {ScreenId} from './screens.js';

export interface AppItem {
	id: string;         // webOS appId — used for the real luna launch
	title: string;
	color: string;      // brand accent — tints the tile + dynamic background
	/** icon bundled into the app (public/icons/*). WAM sandboxes web apps to their own
	 *  dir, so cross-app icon paths are blocked — we ship copies pulled off the TV.
	 *  Monogram fallback if it ever fails to load. */
	icon?: string;
	/** 'internal' opens one of OUR screens (no luna launch) — e.g. the settings overlay */
	launchType?: 'app' | 'input' | 'internal';
}

// Catálogo de Nico (LG OLED C5, webOS rooteada), minimalista a propósito:
// solo lo que usa de verdad. Ids verificados contra `listApps` de la TV
// (2026-10-25) e iconos copiados de cada app real.
export const APPS: Record<Exclude<ScreenId, 'home'>, AppItem[]> = {
	// Up — juego (Moonlight) y Nuvio.
	game: [
		{id: 'com.limelight.webos', title: 'Moonlight', color: '#7c5cf6', icon: 'icons/moonlight.png'},
		{id: 'space.nuvio.webos', title: 'Nuvio TV', color: '#e91e63', icon: 'icons/nuvio.png'}
	],
	// Down — streaming.
	stream: [
		{id: 'iboplayer.lg', title: 'IBO Player', color: '#e11d2e', icon: 'icons/ibo.png'},
		{id: 'netflix', title: 'Netflix', color: '#e50914', icon: 'icons/netflix.png'},
		{id: 'com.telefonica.app.nux', title: 'Movistar Plus+', color: '#019df4', icon: 'icons/movistar.png'}
	],
	// Left — media/alternativo.
	media: [
		{id: 'org.webosbrew.youtube.adfree', title: 'YouTube', color: '#ff0033', icon: 'icons/youtubeadfree.png'},
		{id: 'com.tvweb.dashboard', title: 'Asistenta', color: '#22c1dc', icon: 'icons/asistenta.png'}
	],
	// Right — herramientas.
	misc: [
		{id: 'internal.settings', title: 'Ajustes', color: '#94a3b8', icon: 'icons/settings.png', launchType: 'internal'}
	]
};

/**
 * Los que más usa Nico van primero en el dock (el foco inicial cae en el primer
 * tile). TIENEN que ser ids del catálogo APPS de arriba: un id que no existe no
 * rompe nada, pero silenciosamente no prioriza (bug 2026-11-02: ids antiguos de
 * Nuvio/Movistar que ya no eran los instalados).
 */
export const DOCK_PRIORITY = ['space.nuvio.webos', 'netflix', 'com.telefonica.app.nux'];

/** Orden estable: prioritarios primero (en el orden de DOCK_PRIORITY), el resto conserva su sitio. */
export function sortDockByPriority (items: AppItem[]): AppItem[] {
	const rank = (a: AppItem) => { const i = DOCK_PRIORITY.indexOf(a.id); return i === -1 ? DOCK_PRIORITY.length : i; };
	return [...items].sort((a, b) => rank(a) - rank(b));
}
