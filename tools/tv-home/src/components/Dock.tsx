import {useState, memo} from 'react';
import type {AppItem} from '../lib/apps';

// Dock de apps estilo tvOS (la referencia de free-my-tv): tiles 5:3 con el
// color de marca, una "estantería" de cristal detrás, foco que desplaza la fila
// con UNA transformación de compositor (sin blur: es lo más caro en esta GPU).
const TILE_W = 200;
const TILE_H = 120;
const STEP = 224;
// Altura del dock: tile con foco (120×1.12≈135) + etiqueta (~30) + holgura.
const DOCK_H = 232;
// Los tiles cuelgan de aquí: centrados en el hueco con la etiqueta debajo.
const ROW_TOP = Math.round((DOCK_H - (TILE_H + 34)) / 2) + 6;

const EASE = 'var(--m3-dur-medium) var(--m3-ease-emphasized)';

function AppArt ({app, size}: {app: AppItem; size: number}) {
	const [broken, setBroken] = useState(false);
	const show = app.icon && !broken;
	return (
		<div
			className="flex shrink-0 items-center justify-center overflow-hidden"
			style={{width: size, height: size, borderRadius: size * 0.28, background: 'rgba(255,255,255,0.14)'}}
		>
			{show ? (
				<img src={app.icon} alt="" draggable={false} onError={() => setBroken(true)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
			) : (
				<span className="font-semibold text-white" style={{fontSize: size * 0.44}}>{app.title[0]}</span>
			)}
		</div>
	);
}

const Tile = memo(function Tile ({app, focused, launching}: {app: AppItem; focused: boolean; launching: boolean}) {
	return (
		<div className="flex w-[200px] shrink-0 flex-col items-center">
			<div
				className="flex items-center justify-center rounded-[26px]"
				style={{
					width: TILE_W, height: TILE_H,
					background: focused
						? `linear-gradient(160deg, ${app.color}, ${app.color}b8)`
						: `linear-gradient(160deg, ${app.color}59, ${app.color}2e)`,
					border: `2px solid ${focused ? 'rgba(255,255,255,0.85)' : `${app.color}3d`}`,
					transform: focused ? 'scale(1.12)' : 'scale(1)',
					opacity: focused ? 1 : 0.85,
					transition: `transform ${EASE}, opacity ${EASE}, border-color var(--m3-dur-short) var(--m3-ease-standard)`,
					boxShadow: focused ? `0 0 26px -4px ${app.color}b0, 0 16px 36px -20px rgba(0,0,0,0.9)` : 'none',
					animation: launching ? 'launch-pulse 0.55s var(--m3-ease-emphasized)' : 'none'
				}}
			>
				<AppArt app={app} size={64} />
			</div>
			<span
				className="mt-2.5 max-w-[196px] truncate text-center text-base font-medium"
				style={{color: focused ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)'}}
			>
				{app.title}
			</span>
		</div>
	);
});

export default function Dock ({items, selected, active, launchingId}: {items: AppItem[]; selected: number; active: boolean; launchingId: string | null}) {
	// La fila se centra en el tile enfocado (focus-follow sin medir: métricas
	// fijas) — el foco siempre queda visible aunque haya más apps de las que caben.
	const offset = `calc(50vw - ${selected * STEP + TILE_W / 2}px)`;
	return (
		// Altura real + margen inferior de seguridad (overscan): el tile enfocado
		// (scale 1.12) y su etiqueta quedan siempre dentro de la pantalla.
		<div className="absolute left-0 right-0" style={{bottom: '3.5vh', height: DOCK_H}}>
			{/* Estantería de cristal (dentro de los márgenes laterales) */}
			<div
				className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-[36px]"
				style={{
					width: 'min(90vw, 1720px)', height: 200,
					background: 'rgba(255,255,255,0.055)',
					border: '1px solid rgba(255,255,255,0.10)'
				}}
			/>
			<div
				className="absolute left-0 flex items-start"
				style={{top: ROW_TOP, gap: STEP - TILE_W, transform: `translate3d(${offset}, 0, 0)`, transition: `transform ${EASE}`, willChange: 'transform'}}
			>
				{items.map((app, i) => (
					<Tile key={app.id} app={app} focused={active && i === selected} launching={app.id === launchingId} />
				))}
			</div>
		</div>
	);
}
