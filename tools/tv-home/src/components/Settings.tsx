import {useEffect, useRef, useState, type RefObject} from 'react';
import {APP_VERSION, type HomeConfig} from '../lib/config';
import {resetOrder, CATS, type CatId} from '../lib/order';
import {SCREENS} from '../lib/screens';
import type {AppItem} from '../lib/apps';
import {searchCity, type GeoResult} from '../service/weather';

// Remote-driven settings overlay (QOL config GUI). Up/Down picks a row,
// Left/Right cycles its value (saved immediately by App), OK fires actions,
// Back closes (or leaves a sub-pane). No blur (TV GPU).

const ACCENT = '#7ca8ff';

type Row =
	| {kind: 'choice'; label: string; values: string[]; labels: string[]; get: (c: HomeConfig) => string; set: (c: HomeConfig, v: string) => HomeConfig}
	| {kind: 'action'; label: string; hint: string; action: 'reset' | 'apps'}
	| {kind: 'location'; label: string}
	| {kind: 'tmdbkey'; label: string}
	| {kind: 'name'; label: string}
	| {kind: 'info'; label: string; value: string};

const ROWS: Row[] = [
	{
		kind: 'choice', label: 'Formato de hora', values: ['24', '12'], labels: ['24 h', '12 h'],
		get: (c) => (c.clock24 ? '24' : '12'), set: (c, v) => ({...c, clock24: v === '24'})
	},
	{
		kind: 'choice', label: 'Temperatura', values: ['celsius', 'fahrenheit'], labels: ['°C', '°F'],
		get: (c) => c.tempUnit, set: (c, v) => ({...c, tempUnit: v as HomeConfig['tempUnit']})
	},
	{kind: 'name', label: 'Tu nombre'},
	{kind: 'location', label: 'Ubicación'},
	{
		kind: 'choice', label: 'Tiempo en pantalla', values: ['on', 'off'], labels: ['Sí', 'No'],
		get: (c) => (c.showWeather ? 'on' : 'off'), set: (c, v) => ({...c, showWeather: v === 'on'})
	},
	{
		kind: 'choice', label: 'Salvapantallas', values: ['ambient', 'system'], labels: ['Reloj de la app', 'Arte de la tele'],
		get: (c) => c.tvScreensaver, set: (c, v) => ({...c, tvScreensaver: v as HomeConfig['tvScreensaver']})
	},
	{
		kind: 'choice', label: 'Reloj analógico', values: ['on', 'off'], labels: ['Sí', 'No'],
		get: (c) => (c.analogClock ? 'on' : 'off'), set: (c, v) => ({...c, analogClock: v === 'on'})
	},
	{
		kind: 'choice', label: 'Fotos del momento', values: ['on', 'off'], labels: ['Sí', 'No'],
		get: (c) => (c.ambientPhotos ? 'on' : 'off'), set: (c, v) => ({...c, ambientPhotos: v === 'on'})
	},
	{
		kind: 'choice', label: 'Fondo animado', values: ['on', 'off'], labels: ['Sí', 'No'],
		get: (c) => (c.bgAnimated ? 'on' : 'off'), set: (c, v) => ({...c, bgAnimated: v === 'on'})
	},
	{
		kind: 'choice', label: 'Tema del fondo', values: ['classic', 'mono', 'ember', 'aurora'], labels: ['Clásico', 'Azul', 'Ámbar', 'Aurora'],
		get: (c) => c.bgTheme, set: (c, v) => ({...c, bgTheme: v as HomeConfig['bgTheme']})
	},
	{
		kind: 'choice', label: 'Estrellas', values: ['low', 'normal', 'high'], labels: ['Pocas', 'Normal', 'Muchas'],
		get: (c) => c.bgDensity, set: (c, v) => ({...c, bgDensity: v as HomeConfig['bgDensity']})
	},
	{
		kind: 'choice', label: 'Velocidad', values: ['slow', 'normal', 'fast'], labels: ['Lenta', 'Normal', 'Rápida'],
		get: (c) => c.bgSpeed, set: (c, v) => ({...c, bgSpeed: v as HomeConfig['bgSpeed']})
	},
	{
		kind: 'choice', label: 'Protección OLED', values: ['on', 'off'], labels: ['Sí', 'No'],
		get: (c) => (c.oledGuard ? 'on' : 'off'), set: (c, v) => ({...c, oledGuard: v === 'on'})
	},
	{
		kind: 'choice', label: 'Recomendaciones', values: ['on', 'off'], labels: ['Sí', 'No'],
		get: (c) => (c.picksEnabled ? 'on' : 'off'), set: (c, v) => ({...c, picksEnabled: v === 'on'})
	},
	{kind: 'tmdbkey', label: 'Clave de TMDB'},
	{
		kind: 'choice', label: 'Iconos reales (root)', values: ['off', 'on'], labels: ['No', 'Sí'],
		get: (c) => (c.liveIcons ? 'on' : 'off'), set: (c, v) => ({...c, liveIcons: v === 'on'})
	},
	{kind: 'action', label: 'Gestionar apps', hint: 'OK para abrir', action: 'apps'},
	{kind: 'action', label: 'Orden de apps', hint: 'OK para restablecer', action: 'reset'},
	{kind: 'info', label: 'Versión', value: `v${APP_VERSION}`}
];

const LOCATION_ROW = ROWS.findIndex((r) => r.kind === 'location');
const APPS_ROW = ROWS.findIndex((r) => r.kind === 'action' && r.action === 'apps');
const NAME_ROW = ROWS.findIndex((r) => r.kind === 'name');
const TMDBKEY_ROW = ROWS.findIndex((r) => r.kind === 'tmdbkey');

// Manage-apps pane: every app across all categories; OK (handled by the parent
// key handler) toggles shown/hidden.
function AppsPane ({lists, hidden, row}: {lists: Record<CatId, AppItem[]>; hidden: Set<string>; row: number}) {
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
	useEffect(() => { rowRefs.current[row]?.scrollIntoView({block: 'nearest'}); }, [row]);

	let i = -1;
	return (
		<div className="flex max-h-[52vh] flex-col gap-1 overflow-hidden overflow-y-auto pr-2">
			{CATS.map((cat) => (
				<div key={cat}>
					<div className="px-6 pb-1 pt-3 text-sm font-semibold uppercase tracking-widest" style={{color: SCREENS[cat].accent}}>
						{SCREENS[cat].label}
					</div>
					{lists[cat].map((app) => {
						i++;
						const idx = i;
						const focused = idx === row;
						const isHidden = hidden.has(app.id);
						return (
							<div
								key={app.id}
								ref={(el) => { rowRefs.current[idx] = el; }}
								className="flex items-center justify-between rounded-2xl px-6 py-2.5"
								style={{
									background: focused ? `${ACCENT}1f` : 'transparent',
									border: `1px solid ${focused ? `${ACCENT}66` : 'transparent'}`
								}}
							>
								<span className="text-lg font-medium" style={{color: isHidden ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.92)'}}>
									{app.title}
								</span>
								<span className="text-base font-medium" style={{color: isHidden ? 'rgba(255,255,255,0.4)' : '#7ee7a6'}}>
									{isHidden ? 'Oculta' : 'Visible'}
								</span>
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}

// Location pane: focus the input → the TV's on-screen keyboard opens; typing
// searches Open-Meteo's geocoder (debounced). ↓/OK drops focus into the results
// list; OK there saves the city. Back steps out (results → input → settings).
function LocationPane ({inputRef, query, setQuery, results, searching, mode, resultRow, currentName}: {
	inputRef: RefObject<HTMLInputElement>;
	query: string;
	setQuery: (v: string) => void;
	results: GeoResult[];
	searching: boolean;
	mode: 'type' | 'pick';
	resultRow: number;
	currentName: string;
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="px-1 text-base text-white/45">Ahora: <span className="text-white/80">{currentName}</span></div>
			<input
				ref={inputRef}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Busca una ciudad…"
				spellCheck={false}
				autoComplete="off"
				className="w-full rounded-2xl px-6 py-4 text-xl text-white/95 outline-none"
				style={{
					background: 'rgba(255,255,255,0.06)',
					border: `1px solid ${mode === 'type' ? `${ACCENT}aa` : 'rgba(255,255,255,0.14)'}`
				}}
			/>
			<div className="flex max-h-[38vh] min-h-[6rem] flex-col gap-1 overflow-y-auto pr-1">
				{searching && <div className="px-6 py-3 text-lg text-white/45">Buscando…</div>}
				{!searching && !!query.trim() && results.length === 0 && (
					<div className="px-6 py-3 text-lg text-white/45">Sin resultados</div>
				)}
				{results.map((g, i) => {
					const focused = mode === 'pick' && i === resultRow;
					return (
						<div
							key={`${g.label}-${g.latitude}-${g.longitude}`}
							className="flex items-center rounded-2xl px-6 py-3"
							style={{
								background: focused ? `${ACCENT}1f` : 'transparent',
								border: `1px solid ${focused ? `${ACCENT}66` : 'transparent'}`
							}}
						>
							<span className="text-lg font-medium text-white/90">{g.label}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

export default function Settings ({config, onChange, onClose, onOrderReset, lists, hidden, onToggleHide}: {
	config: HomeConfig;
	onChange: (c: HomeConfig) => void;
	onClose: () => void;
	onOrderReset: () => void;
	lists: Record<CatId, AppItem[]>;
	hidden: Set<string>;
	onToggleHide: (id: string) => void;
}) {
	const [pane, setPane] = useState<'main' | 'apps' | 'location' | 'tmdb' | 'name'>('main');
	const [row, setRow] = useState(0);
	const [resetDone, setResetDone] = useState(false);
	const rowEls = useRef<(HTMLDivElement | null)[]>([]);

	// location-pane state
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<GeoResult[]>([]);
	const [searching, setSearching] = useState(false);
	const [locMode, setLocMode] = useState<'type' | 'pick'>('type');
	const [resultRow, setResultRow] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// internal tiles (this settings screen) can't be hidden — you'd be locked out
	const manageable = {
		game: lists.game.filter((a) => a.launchType !== 'internal'),
		stream: lists.stream.filter((a) => a.launchType !== 'internal'),
		media: lists.media.filter((a) => a.launchType !== 'internal'),
		misc: lists.misc.filter((a) => a.launchType !== 'internal')
	};
	const flatApps = CATS.flatMap((cat) => manageable[cat]);
	const rowCount = pane === 'main' ? ROWS.length : flatApps.length;

	const openLocation = () => { setPane('location'); setLocMode('type'); setQuery(''); setResults([]); setResultRow(0); };
	const openTmdb = () => { setPane('tmdb'); setQuery(config.tmdbKey); };
	const closeTmdb = () => { setPane('main'); setRow(TMDBKEY_ROW); setQuery(''); };
	const openName = () => { setPane('name'); setQuery(config.userName); };
	const closeName = () => { setPane('main'); setRow(NAME_ROW); setQuery(''); };
	const closeLocation = () => { setPane('main'); setRow(LOCATION_ROW); setQuery(''); setResults([]); setLocMode('type'); };

	// La fila enfocada queda siempre a la vista dentro del panel con scroll.
	useEffect(() => {
		if (pane === 'main') rowEls.current[row]?.scrollIntoView({block: 'nearest'});
	}, [row, pane]);

	// Debounced geocoder search while typing.
	useEffect(() => {
		if (pane !== 'location') return;
		if (!query.trim()) { setResults([]); setSearching(false); return; }
		setSearching(true);
		let alive = true;
		const id = window.setTimeout(() => {
			searchCity(query).then((res) => { if (alive) { setResults(res); setSearching(false); } });
		}, 350);
		return () => { alive = false; window.clearTimeout(id); };
	}, [query, pane]);

	// Keep the input focused whenever we're in typing mode (opens the TV keyboard).
	useEffect(() => {
		if ((pane === 'location' && locMode === 'type') || pane === 'tmdb' || pane === 'name') {
			const id = window.setTimeout(() => inputRef.current?.focus(), 0);
			return () => window.clearTimeout(id);
		}
	}, [pane, locMode]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const typing = (pane === 'location' && locMode === 'type') || pane === 'tmdb' || pane === 'name';
			// While typing, Backspace edits text — don't treat it as Back.
			const isBack = e.keyCode === 461 || e.key === 'GoBack' || e.key === 'Escape'
				|| (e.key === 'Backspace' && !typing);

			// Typing mode: let characters + the IME through; only steal Back and the
			// "go to results" keys.
			if (typing) {
				if (pane === 'name') {
					if (isBack) { e.preventDefault(); e.stopPropagation(); closeName(); return; }
					if (e.key === 'Enter') {
						e.preventDefault(); e.stopPropagation();
						onChange({...config, userName: query.trim() || config.userName});
						closeName();
					}
					return;   // el resto: input nativo
				}
				if (pane === 'tmdb') {
					if (isBack) { e.preventDefault(); e.stopPropagation(); closeTmdb(); return; }
					if (e.key === 'Enter') {
						e.preventDefault(); e.stopPropagation();
						onChange({...config, tmdbKey: query.trim()});
						closeTmdb();
					}
					return;   // el resto: input nativo
				}
				if (isBack) { e.preventDefault(); e.stopPropagation(); closeLocation(); return; }
				if ((e.key === 'Enter' || e.key === 'ArrowDown') && results.length) {
					e.preventDefault(); e.stopPropagation();
					inputRef.current?.blur();
					setLocMode('pick'); setResultRow(0);
				}
				return;   // everything else: native input handling
			}

			// All other contexts fully own the keys.
			e.preventDefault();
			e.stopPropagation();

			// Location pane, picking a result
			if (pane === 'location') {
				if (isBack) { setLocMode('type'); return; }   // back to editing
				if (e.key === 'ArrowUp') {
					if (resultRow <= 0) setLocMode('type');
					else setResultRow(resultRow - 1);
					return;
				}
				if (e.key === 'ArrowDown') { setResultRow(Math.min(results.length - 1, resultRow + 1)); return; }
				if (e.key === 'Enter') {
					const g = results[resultRow];
					if (g) { onChange({...config, location: {name: g.name, latitude: g.latitude, longitude: g.longitude}}); closeLocation(); }
					return;
				}
				return;
			}

			if (isBack) {
				if (pane === 'apps') { setPane('main'); setRow(APPS_ROW); }
				else onClose();
				return;
			}
			if (e.key === 'ArrowUp') { setRow((r) => Math.max(0, r - 1)); return; }
			if (e.key === 'ArrowDown') { setRow((r) => Math.min(rowCount - 1, r + 1)); return; }
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Enter') return;

			if (pane === 'apps') {
				const app = flatApps[row];
				if (app && e.key === 'Enter') onToggleHide(app.id);
				return;
			}
			const def = ROWS[row];
			if (def.kind === 'info') return;
			if (def.kind === 'location') { if (e.key === 'Enter') openLocation(); return; }
			if (def.kind === 'tmdbkey') { if (e.key === 'Enter') openTmdb(); return; }
			if (def.kind === 'name') { if (e.key === 'Enter') openName(); return; }
			if (def.kind === 'action') {
				if (e.key !== 'Enter') return;
				if (def.action === 'reset') { resetOrder(); onOrderReset(); setResetDone(true); }
				else { setPane('apps'); setRow(0); }
				return;
			}
			const cur = def.values.indexOf(def.get(config));
			const step = e.key === 'ArrowLeft' ? -1 : 1;
			const next = def.values[(cur + step + def.values.length) % def.values.length];
			onChange(def.set(config, next));
		};
		// capture phase so the app-wide nav handler never sees these keys
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [pane, row, rowCount, config, onChange, onClose, onOrderReset, flatApps, onToggleHide, locMode, results, resultRow]);

	const title = pane === 'main' ? 'Ajustes' : pane === 'apps' ? 'Gestionar apps' : pane === 'tmdb' ? 'Clave de TMDB' : pane === 'name' ? 'Tu nombre' : 'Elige tu ciudad';
	const hint = pane === 'tmdb'
		? 'Pega tu clave · OK guarda · Back cancela (gratis en themoviedb.org)'
		: pane === 'name'
		? 'Escribe cómo te saluda el Home · OK guarda · Back cancela'
		: pane === 'apps'
		? '↑↓ elegir · OK mostrar u ocultar · Back volver'
		: pane === 'location'
			? (locMode === 'type' ? 'Escribe una ciudad · ↓ resultados · Back volver' : '↑↓ elegir · OK seleccionar · Back editar')
			: '↑↓ elegir · ‹ › cambiar · OK abrir · Back cerrar';

	return (
		<div className="absolute inset-0 z-30 flex items-center justify-center" style={{background: 'rgba(0,0,0,0.72)'}}>
			<div className="m3-card w-[720px] px-10 py-8" style={{animation: 'rise-in 0.35s var(--m3-ease-emphasized) both'}}>
				<h2 className="mb-6 text-[34px] font-normal tracking-tight" style={{color: ACCENT}}>{title}</h2>

				{pane === 'name' ? (
					<div className="flex flex-col gap-3">
						<div className="px-1 text-base text-white/45">Así te saluda el Home. Puedes poner los dos nombres.</div>
						<input
							ref={inputRef}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Nico y Nai"
							spellCheck={false}
							autoComplete="off"
							className="w-full rounded-2xl px-6 py-4 text-xl text-white/95 outline-none"
							style={{background: 'rgba(255,255,255,0.06)', border: `1px solid ${ACCENT}aa`}}
						/>
					</div>
				) : pane === 'tmdb' ? (
					<div className="flex flex-col gap-3">
						<div className="px-1 text-base text-white/45">
							{config.tmdbKey ? 'Hay una clave guardada (solo en esta TV).' : 'Sin clave: las recomendaciones se esconden.'}
						</div>
						<input
							ref={inputRef}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Clave TMDB o Read Access Token…"
							spellCheck={false}
							autoComplete="off"
							className="w-full rounded-2xl px-6 py-4 text-xl text-white/95 outline-none"
							style={{background: 'rgba(255,255,255,0.06)', border: `1px solid ${ACCENT}aa`}}
						/>
					</div>
				) : pane === 'apps' ? (
					<AppsPane lists={manageable} hidden={hidden} row={row} />
				) : pane === 'location' ? (
					<LocationPane
						inputRef={inputRef} query={query} setQuery={setQuery} results={results}
						searching={searching} mode={locMode} resultRow={resultRow} currentName={config.location.name}
					/>
				) : (
					<div className="flex max-h-[58vh] flex-col gap-2 overflow-y-auto pr-2">
						{ROWS.map((def, i) => {
							const focused = i === row;
							return (
								<div
									key={def.label}
									ref={(el) => { rowEls.current[i] = el; }}
									className="flex items-center justify-between rounded-2xl px-6 py-4"
									style={{
										background: focused ? `${ACCENT}1f` : 'transparent',
										border: `1px solid ${focused ? `${ACCENT}66` : 'transparent'}`,
										transition: 'background var(--m3-dur-short) var(--m3-ease-standard), border-color var(--m3-dur-short) var(--m3-ease-standard)'
									}}
								>
									<span className="text-xl font-medium text-white/92">{def.label}</span>
									{def.kind === 'choice' ? (
										<span className="flex items-center gap-3 text-lg" style={{color: focused ? ACCENT : 'rgba(255,255,255,0.55)'}}>
											{focused && <span className="opacity-70">‹</span>}
											<span className="min-w-[104px] text-center font-medium">{def.labels[def.values.indexOf(def.get(config))]}</span>
											{focused && <span className="opacity-70">›</span>}
										</span>
									) : def.kind === 'location' ? (
										<span className="flex items-center gap-2 text-lg font-medium" style={{color: focused ? ACCENT : 'rgba(255,255,255,0.55)'}}>
											<span className="max-w-[280px] truncate text-right">{config.location.name}</span>
											{focused && <span className="opacity-70">›</span>}
										</span>
									) : def.kind === 'tmdbkey' ? (
										<span className="flex items-center gap-2 text-lg font-medium" style={{color: focused ? ACCENT : 'rgba(255,255,255,0.55)'}}>
											<span>{config.tmdbKey ? 'Guardada ✓' : 'Sin clave'}</span>
											{focused && <span className="opacity-70">›</span>}
										</span>
									) : def.kind === 'name' ? (
										<span className="flex items-center gap-2 text-lg font-medium" style={{color: focused ? ACCENT : 'rgba(255,255,255,0.55)'}}>
											<span className="max-w-[280px] truncate text-right">{config.userName}</span>
											{focused && <span className="opacity-70">›</span>}
										</span>
									) : def.kind === 'info' ? (
										<span className="text-lg font-medium text-white/40">{def.value}</span>
									) : (
										<span className="text-lg font-medium" style={{color: focused ? ACCENT : 'rgba(255,255,255,0.55)'}}>
											{def.action === 'reset' && resetDone ? 'Hecho ✓' : def.hint}
										</span>
									)}
								</div>
							);
						})}
					</div>
				)}

				<p className="mt-6 text-center text-base text-white/40">{hint}</p>
			</div>
		</div>
	);
}
