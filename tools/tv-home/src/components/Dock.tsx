import {useState, memo} from 'react';
import type {AppItem} from '../lib/apps';

// Dock minimalista: una píldora de cristal fina solo con iconos (sin nombres),
// grandes y limpios. El foco es un anillo blanco fino + un halo neutro; el
// movimiento va por transformaciones de compositor.
const TILE = 136;
const STEP = 186;
const VISIBLE = 5;
const DOCK_H = 176;
const PAD = 30;   // holgura del recorte para que el tile enfocado no se corte

const EASE = 'var(--m3-dur-short) var(--m3-ease-emphasized)';

function AppArt ({app}: {app: AppItem}) {
	const [broken, setBroken] = useState(false);
	const show = app.icon && !broken;
	if (show) {
		return <img src={app.icon} alt="" draggable={false} onError={() => setBroken(true)} className="h-full w-full object-cover" />;
	}
	return <span className="font-medium text-white/85" style={{fontSize: TILE * 0.38}}>{app.title[0]}</span>;
}

const Tile = memo(function Tile ({app, focused, launching}: {app: AppItem; focused: boolean; launching: boolean}) {
	return (
		<div
			className="flex shrink-0 items-center justify-center overflow-hidden"
			style={{
				width: TILE, height: TILE, borderRadius: 38,
				background: 'rgba(255,255,255,0.055)',
				border: `2px solid ${focused ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.045)'}`,
				transform: focused ? 'scale(1.06)' : 'scale(1)',
				opacity: focused ? 1 : 0.82,
				transition: `transform ${EASE}, opacity ${EASE}, border-color var(--m3-dur-short) var(--m3-ease-standard)`,
				boxShadow: focused ? '0 0 0 1px rgba(124,168,255,0.22), 0 18px 44px -18px rgba(0,0,0,0.9)' : 'none',
				animation: launching ? 'launch-pulse 0.55s var(--m3-ease-emphasized)' : 'none'
			}}
		>
			<AppArt app={app} />
		</div>
	);
});

export default function Dock ({items, selected, active, launchingId}: {items: AppItem[]; selected: number; active: boolean; launchingId: string | null}) {
	// Ventana de VISIBLE tiles centrada en pantalla. Si la fila no cabe, el foco
	// la desplaza y la ventana recorta: nunca se sale de la píldora.
	const VW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1920;
	const rowW = items.length * STEP - (STEP - TILE);
	const winW = Math.min(rowW, VISIBLE * STEP - (STEP - TILE));
	const winLeft = (VW - winW) / 2;

	let offset: number;
	if (rowW <= winW) {
		offset = winLeft;   // todo cabe: fila centrada
	} else {
		const centered = winLeft + winW / 2 - (selected * STEP + TILE / 2);
		const minOff = winLeft;
		const maxOff = winLeft + winW - rowW;
		offset = Math.min(Math.max(centered, maxOff), minOff);
	}
	return (
		<div className="absolute left-0 right-0" style={{bottom: '4vh', height: DOCK_H}}>
			{/* píldora de cristal ajustada a la ventana visible (sin blur: GPU) */}
			<div
				className="absolute left-1/2 -translate-x-1/2 rounded-full"
				style={{
					width: winW + 64, height: 158, top: 9,
					background: 'rgba(12,14,20,0.52)',
					border: '1px solid rgba(255,255,255,0.06)',
					boxShadow: '0 30px 70px -40px rgba(0,0,0,0.9)'
				}}
			/>
			{/* Ventana con recorte: los tiles de fuera no se ven */}
			<div
				className="absolute overflow-hidden"
				style={{left: winLeft - PAD, width: winW + PAD * 2, top: 0, height: DOCK_H}}
			>
				<div
					className="absolute flex items-start"
					style={{
						left: PAD, top: 20, gap: STEP - TILE,
						transform: `translate3d(${offset - winLeft}px, 0, 0)`,
						transition: `transform ${EASE}`, willChange: 'transform'
					}}
				>
					{items.map((app, i) => (
						<Tile key={app.id} app={app} focused={active && i === selected} launching={app.id === launchingId} />
					))}
				</div>
			</div>
		</div>
	);
}
