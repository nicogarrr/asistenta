import {useConfig} from '../lib/config';

// Cohete sutil temática ASTS/SpaceX, SOLO CSS: un SVG inline (una textura de
// ~50x100 px en GPU) animado con transform/opacity en un ciclo largo — visible
// ~22 s cada 5 min, el resto fuera de pantalla. Cero JS por frame, cero canvas,
// compositor-only. Si Ajustes → "Animación de fondo" está Off, no se muestra.
// Coste medido (Chrome, 1920×1080): ver docs/NICO_PLAN.md.
export default function Rocket () {
	const {bgAnimated, rocketEnabled} = useConfig();
	if (!bgAnimated || !rocketEnabled) return null;
	return (
		<div className="rocket-layer" aria-hidden="true">
			<svg width="46" height="96" viewBox="0 0 46 96" fill="none">
				{/* Falcon-9-ish: cuerpo blanco, punta gris, llamarada pequeña */}
				<path d="M23 2 C28 10 30 18 30 30 L30 62 L16 62 L16 30 C16 18 18 10 23 2 Z" fill="rgba(232,236,244,0.92)"/>
				<path d="M23 2 C28 10 30 18 30 30 L16 30 C16 18 18 10 23 2 Z" fill="rgba(148,163,184,0.9)"/>
				<rect x="16" y="44" width="14" height="6" fill="rgba(30,41,59,0.85)"/>
				<path d="M16 62 L8 78 L16 74 Z" fill="rgba(148,163,184,0.75)"/>
				<path d="M30 62 L38 78 L30 74 Z" fill="rgba(148,163,184,0.75)"/>
				<ellipse cx="23" cy="72" rx="4.5" ry="14" fill="rgba(251,191,36,0.85)"/>
				<ellipse cx="23" cy="70" rx="2.5" ry="9" fill="rgba(254,243,199,0.95)"/>
			</svg>
		</div>
	);
}
