import type {ScreenId} from './screens';

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

// Catálogo de Nico (LG OLED C5, webOS 26 rooteada).
// OJO: los appId marcados "VERIFICAR" salen de conocimiento general, no de su TV.
// Cualquier app instalada que falte aparece sola en "Apps" gracias al
// descubrimiento en caliente (App.tsx → listLaunchPoints). En fase 2 un
// inventario de solo lectura confirma IDs y completa iconos.
export const APPS: Record<Exclude<ScreenId, 'home'>, AppItem[]> = {
	// Up — entradas HDMI y juego en la nube.
	game: [
		{id: 'com.webos.app.hdmi1', title: 'HDMI 1', color: '#2f6cf6', launchType: 'input'},
		{id: 'com.webos.app.hdmi2', title: 'HDMI 2', color: '#7c5cf6', launchType: 'input'},
		{id: 'com.webos.app.hdmi3', title: 'HDMI 3', color: '#5c8df6', launchType: 'input'},
		{id: 'com.nvidia.gfn.webos', title: 'GeForce NOW', color: '#76b900'}   // VERIFICAR id
	],
	// Down — streaming instalado en su TV.
	stream: [
		{id: 'netflix', title: 'Netflix', color: '#e50914', icon: 'icons/netflix.png'},
		{id: 'amazon', title: 'Prime Video', color: '#00a8e1', icon: 'icons/prime.png'},
		{id: 'com.disney.disneyplus-prod', title: 'Disney+', color: '#1f6feb', icon: 'icons/disney.png'},
		{id: 'com.wbd.stream', title: 'Max', color: '#7b2ff7', icon: 'icons/hbomax.png'},   // VERIFICAR id (Max ES)
		{id: 'com.movistarplus.es.iptv', title: 'Movistar Plus+', color: '#019df4'},        // VERIFICAR id
		{id: 'com.dazn.ott.lg', title: 'DAZN', color: '#0c161f'},                            // VERIFICAR id
		{id: 'com.skyshowtime.webos', title: 'SkyShowtime', color: '#8a2be2'},               // VERIFICAR id
		{id: 'com.apple.appletv', title: 'Apple TV', color: '#b8bcc4', icon: 'icons/appletv.png'}
	],
	// Left — media local / alternativo.
	media: [
		{id: 'youtube.leanback.v4', title: 'YouTube AdFree', color: '#ff0033', icon: 'icons/youtube.png'},   // VERIFICAR: id del homebrew AdFree en su TV
		{id: 'com.nuvio.tv', title: 'NuvioTV', color: '#e91e63'},                 // VERIFICAR id
		{id: 'com.stremio.webos', title: 'Stremio', color: '#8a5cff'},            // VERIFICAR id
		{id: 'org.xbmc.kodi', title: 'Kodi', color: '#17b2e7'},                   // VERIFICAR id
		{id: 'com.iboplayer.pro', title: 'IBO Player Pro', color: '#ff6d00'}      // VERIFICAR id
	],
	// Right — herramientas.
	misc: [
		{id: 'org.webosbrew.hbchannel', title: 'Homebrew', color: '#34d399', icon: 'icons/homebrew.png'},
		{id: 'internal.settings', title: 'Ajustes', color: '#94a3b8', icon: 'icons/settings.png', launchType: 'internal'}
	]
};
