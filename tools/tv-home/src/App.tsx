import {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import Background from './components/Background';
import Settings from './components/Settings';
import Ambient from './components/Ambient';
import Home from './screens/Home';
import Rocket from './components/Rocket';
import {useRemoteNav, type Zone} from './hooks/useRemoteNav';
import type {AppItem} from './lib/apps';
import {buildLists, loadHidden, saveHidden, type CatId} from './lib/order';
import {ConfigContext, loadConfig, saveConfig, type HomeConfig} from './lib/config';
import {fetchPicks, type Pick} from './service/tmdb';
import {launchApp, listLaunchPoints, blockScreenSaver, assertSoundOutput, guardSoundOutput, isWebOS} from './service/luna';

const IDLE_MS = 60_000;      // sin input este tiempo → reloj ambient
const JITTER_MS = 150_000;   // guardia OLED: desplaza la UI ±2px con esta cadencia
const PICKS_REFRESH_MS = 30 * 60_000;

// Orden del dock: sus categorías de siempre en orden de uso.
const DOCK_ORDER: CatId[] = ['stream', 'media', 'game', 'misc'];
// Lo que más usa Nico va primero en el dock (el foco inicial cae en el primer
// tile). El resto mantiene el orden de categorías detrás.
const DOCK_PRIORITY = ['com.nuvio.tv', 'netflix', 'com.movistarplus.es.iptv'];

export default function App () {
	const [zone, setZone] = useState<Zone>('dock');
	const [heroSel, setHeroSel] = useState(0);
	const [dockSel, setDockSel] = useState(0);
	const [picks, setPicks] = useState<Pick[]>([]);
	const [discovered, setDiscovered] = useState<AppItem[]>([]);
	const [hidden, setHidden] = useState<Set<string>>(loadHidden);
	const [lists, setLists] = useState<Record<CatId, AppItem[]>>(() => buildLists());
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [ambient, setAmbient] = useState(false);
	const [config, setConfig] = useState<HomeConfig>(loadConfig);
	const [toast, setToast] = useState<string | null>(null);
	const [launchFx, setLaunchFx] = useState<string | null>(null);
	const [jitter, setJitter] = useState({x: 0, y: 0});
	const lastInput = useRef(Date.now());
	const toastTimer = useRef(0);

	// Dock aplanado (visibles), en orden de uso. El tile de Ajustes va en misc.
	const dock = useMemo(() => {
		const flat = DOCK_ORDER.flatMap((cat) => lists[cat].filter((a) => !hidden.has(a.id)));
		const rank = (a: AppItem) => { const i = DOCK_PRIORITY.indexOf(a.id); return i === -1 ? DOCK_PRIORITY.length : i; };
		return flat.sort((a, b) => rank(a) - rank(b));   // sort estable: el resto conserva su orden
	}, [lists, hidden]);

	const showToast = useCallback((msg: string) => {
		setToast(msg);
		window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), 2600);
	}, []);

	// Recomendaciones TMDB (free-my-tv). Sin clave: sección oculta.
	useEffect(() => {
		if (!config.picksEnabled || !config.tmdbKey.trim()) { setPicks([]); return; }
		let alive = true;
		const load = () => { fetchPicks(config.tmdbKey, config.tmdbRegion).then((p) => { if (alive) setPicks(p); }); };
		load();
		const id = window.setInterval(load, PICKS_REFRESH_MS);
		return () => { alive = false; window.clearInterval(id); };
	}, [config.picksEnabled, config.tmdbKey, config.tmdbRegion]);

	const heroPicks = useMemo(() => picks.slice(0, 3), [picks]);

	// Descubrimiento en caliente: las apps instaladas en la TV que falten en el
	// catálogo aparecen solas en "Apps" (monograma; los iconos van en el paquete).
	useEffect(() => {
		if (!isWebOS()) return;
		listLaunchPoints()
			.then((res) => {
				const known = new Set<string>();
				for (const cat of ['game', 'stream', 'media', 'misc'] as CatId[]) {
					for (const a of buildLists()[cat]) known.add(a.id);
				}
				const extra: AppItem[] = (res.launchPoints || [])
					.filter((lp) => !known.has(lp.id))
					.map((lp) => ({id: lp.id, title: lp.title, color: '#8ea2ff'}));
				if (extra.length) {
					setDiscovered(extra);
					setLists(buildLists(extra));
				}
			})
			.catch(() => { /* el catálogo basta */ });
	}, []);

	// Salvapantallas: 'ambient' (por defecto) veta el de la TV y pone el reloj;
	// 'system' lo deja pasar (kit de arte, una vez verificado en la TV).
	useEffect(() => {
		if (config.tvScreensaver !== 'ambient') return;
		return blockScreenSaver();
	}, [config.tvScreensaver]);

	// Guardia eARC (ver luna.ts): LG home renegocia el audio al enfocar apps; al
	// sustituirlo hay que reafirmar la salida configurada tras lanzar y al volver.
	useEffect(() => {
		if (!isWebOS()) return;
		const cancelGuard = guardSoundOutput();
		const onVis = () => { if (!document.hidden) assertSoundOutput().catch(() => { /* best-effort */ }); };
		document.addEventListener('visibilitychange', onVis);
		return () => { cancelGuard(); document.removeEventListener('visibilitychange', onVis); };
	}, []);

	// Idle → ambient. Cualquier input despierta (la tecla que despierta no navega).
	useEffect(() => {
		const poke = () => { lastInput.current = Date.now(); setAmbient(false); };
		window.addEventListener('keydown', poke, true);
		window.addEventListener('pointermove', poke, true);
		window.addEventListener('mousedown', poke, true);
		const id = window.setInterval(() => {
			if (!settingsOpen && Date.now() - lastInput.current >= IDLE_MS) {
				setAmbient(true);
			}
		}, 5000);
		return () => {
			window.clearInterval(id);
			window.removeEventListener('keydown', poke, true);
			window.removeEventListener('pointermove', poke, true);
			window.removeEventListener('mousedown', poke, true);
		};
	}, [settingsOpen]);

	// Guardia OLED: jitter lento de toda la UI.
	useEffect(() => {
		const id = window.setInterval(() => {
			setJitter({x: Math.round(Math.random() * 4 - 2), y: Math.round(Math.random() * 4 - 2)});
		}, JITTER_MS);
		return () => window.clearInterval(id);
	}, []);

	const onLaunch = useCallback(() => {
		// Clave de pulso para el feedback visual del lanzamiento.
		if (zone === 'hero') {
			const pick = heroPicks[heroSel];
			if (!pick) return;
			const key = `${pick.kind}-${pick.id}`;
			setLaunchFx(key);
			window.setTimeout(() => setLaunchFx(null), 700);
			if (isWebOS()) {
				window.setTimeout(() => { assertSoundOutput().catch(() => { /* best-effort */ }); }, 1500);
				launchApp(pick.providerAppId).catch(() => showToast(`No se pudo abrir ${pick.providerName}`));
			}
			return;
		}
		const app = dock[dockSel];
		if (!app) return;
		if (app.launchType === 'internal') { setSettingsOpen(true); return; }
		setLaunchFx(app.id);
		window.setTimeout(() => setLaunchFx(null), 700);
		if (isWebOS()) {
			window.setTimeout(() => { assertSoundOutput().catch(() => { /* best-effort */ }); }, 1500);
			launchApp(app.id).catch(() => showToast(`No se pudo abrir ${app.title}`));
		}
	}, [zone, heroSel, dockSel, heroPicks, dock, showToast]);

	const onConfigChange = useCallback((c: HomeConfig) => { setConfig(c); saveConfig(c); }, []);
	const onOrderReset = useCallback(() => setLists(buildLists(discovered)), [discovered]);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	const onToggleHide = useCallback((id: string) => {
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			saveHidden(next);
			return next;
		});
	}, []);

	useRemoteNav({
		zone, setZone,
		heroCount: heroPicks.length, dockCount: dock.length,
		heroSel, setHeroSel, dockSel, setDockSel,
		onLaunch,
		enabled: !settingsOpen && !ambient
	});

	return (
		<ConfigContext.Provider value={config}>
			<div className="relative h-full w-full overflow-hidden bg-background">
				<Background screen="home" ambient={ambient} />

				<div
					className="absolute inset-0 z-10 h-full w-full"
					style={{
						transform: `translate(${jitter.x}px, ${jitter.y}px)`,
						transition: 'opacity 1s ease',
						opacity: ambient ? 0 : 1
					}}
				>
					<Rocket />
					<Home
						picks={heroPicks}
						heroSel={heroSel}
						dock={dock}
						dockSel={dockSel}
						zone={zone}
						launchingKey={launchFx}
					/>
				</div>

				{ambient && <Ambient picks={picks} />}

				{settingsOpen && (
					<Settings
						config={config} onChange={onConfigChange} onClose={closeSettings}
						onOrderReset={onOrderReset}
						lists={lists} hidden={hidden} onToggleHide={onToggleHide}
					/>
				)}

				<div
					className="absolute left-1/2 top-[6vh] z-50 -translate-x-1/2 whitespace-nowrap rounded-full px-7 py-3.5 text-lg font-medium"
					style={{
						color: '#eef1ff',
						background: 'rgba(20,24,38,0.92)',
						border: '1px solid rgba(124,168,255,0.4)',
						opacity: toast ? 1 : 0,
						transform: `translateX(-50%) translateY(${toast ? 0 : -8}px)`,
						transition: 'opacity 0.3s ease, transform 0.3s ease',
						pointerEvents: 'none'
					}}
				>
					{toast}
				</div>
			</div>
		</ConfigContext.Provider>
	);
}
