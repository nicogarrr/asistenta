import {useEffect} from 'react';

// Navegación por zonas (pantalla única): ↑↓ alterna entre "Para ti" (hero) y el
// dock; ←→ mueve dentro de la fila; OK lanza; Back no hace nada en el Home (es
// la pantalla raíz). El overlay de Ajustes captura las teclas antes (enabled).
export type Zone = 'hero' | 'dock';

interface Handlers {
	zone: Zone;
	setZone: (z: Zone) => void;
	heroCount: number;
	dockCount: number;
	heroSel: number;
	setHeroSel: (updater: (prev: number) => number) => void;
	dockSel: number;
	setDockSel: (updater: (prev: number) => number) => void;
	onLaunch: () => void;
	enabled: boolean;
}

export function useRemoteNav ({zone, setZone, heroCount, dockCount, heroSel, setHeroSel, dockSel, setDockSel, onLaunch, enabled}: Handlers) {
	useEffect(() => {
		if (!enabled) return;

		const onKeyDown = (e: KeyboardEvent) => {
			const isBack = e.keyCode === 461 || e.key === 'Escape' || e.key === 'GoBack';
			if (isBack) { e.preventDefault(); return; }   // el Home es raíz: Back no sale

			if (e.key === 'Enter') {
				if (e.repeat) return;
				e.preventDefault();
				onLaunch();
				return;
			}

			if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
				e.preventDefault();
				if (!heroCount) return;   // sin picks solo existe el dock
				setZone(zone === 'dock' ? 'hero' : 'dock');
				return;
			}

			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				e.preventDefault();
				const delta = e.key === 'ArrowRight' ? 1 : -1;
				if (zone === 'hero') setHeroSel((p) => Math.max(0, Math.min(heroCount - 1, p + delta)));
				else setDockSel((p) => Math.max(0, Math.min(dockCount - 1, p + delta)));
			}
		};

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [zone, setZone, heroCount, dockCount, heroSel, setHeroSel, dockSel, setDockSel, onLaunch, enabled]);
}
