import {useEffect} from 'react';

// Navegación por zonas (pantalla única): ↑↓ alterna entre "Para ti" (hero) y el
// dock; ←→ mueve dentro de la fila; OK lanza; Back abre la salida al Home de LG
// (diálogo Quedarse/Salir, estilo CleanFrame). Los overlays capturan antes
// (enabled). Tecla mantenida actúa una vez (OK/Back), las flechas repiten.
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
	onBack: () => void;
	enabled: boolean;
}

export function useRemoteNav ({zone, setZone, heroCount, dockCount, heroSel, setHeroSel, dockSel, setDockSel, onLaunch, onBack, enabled}: Handlers) {
	useEffect(() => {
		if (!enabled) return;

		const onKeyDown = (e: KeyboardEvent) => {
			const isBack = e.keyCode === 461 || e.key === 'Escape' || e.key === 'GoBack';
			if (isBack) {
				e.preventDefault();
				if (!e.repeat) onBack();   // mantenida: una sola vez
				return;
			}

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
	}, [zone, setZone, heroCount, dockCount, heroSel, setHeroSel, dockSel, setDockSel, onLaunch, onBack, enabled]);
}
