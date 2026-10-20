import {useEffect, useState} from 'react';

// Escape hatch estilo CleanFrame: Back en el Home ofrece quedarse o salir al
// Home de LG (el foco nunca sale; OK confirma; Back cancela). Se cierra solo
// con una decisión — sin temporizadores.
export const LG_HOME_APP_ID = 'com.webos.app.home';   // VERIFICAR en fase 2 (inventario de la TV)

export default function ExitPrompt ({onStay, onLeave}: {onStay: () => void; onLeave: () => void}) {
	const [sel, setSel] = useState(0);   // 0 = Quedarse (por defecto, lo seguro)

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.repeat) return;   // tecla mantenida actúa una vez (disciplina CleanFrame)
			const isBack = e.keyCode === 461 || e.key === 'Escape' || e.key === 'GoBack';
			if (isBack) { e.preventDefault(); e.stopPropagation(); onStay(); return; }
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				e.preventDefault(); e.stopPropagation(); setSel((s) => (s === 0 ? 1 : 0)); return;
			}
			if (e.key === 'Enter') {
				e.preventDefault(); e.stopPropagation();
				if (sel === 0) onStay(); else onLeave();
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [sel, onStay, onLeave]);

	const btn = (label: string, i: number) => (
		<div
			className="rounded-2xl px-8 py-3 text-xl font-medium"
			style={{
				background: sel === i ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.10)',
				color: sel === i ? '#0b0d12' : 'rgba(255,255,255,0.75)',
				border: `1px solid ${sel === i ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.18)'}`,
				transition: 'background 150ms ease, color 150ms ease'
			}}
		>
			{label}
		</div>
	);

	return (
		<div className="absolute inset-0 z-50 flex items-end justify-center" style={{background: 'rgba(0,0,0,0.45)', paddingBottom: '12vh', animation: 'rise-in 0.25s ease both'}}>
			<div
				className="flex flex-col items-center gap-6 rounded-[28px] px-12 py-8"
				style={{background: 'rgba(14,16,22,0.88)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)'}}
			>
				<div className="text-2xl font-normal text-white/90">¿Salir al Home de LG?</div>
				<div className="flex gap-4">{btn('Quedarse', 0)}{btn('Salir', 1)}</div>
			</div>
		</div>
	);
}
