// Saludo segun la hora LOCAL de la TV (la del navegador de webOS, que sigue el huso
// horario configurado en la TV). Convencion (la ya usada por la etiqueta "Para ti"):
//   06:00-11:59 Buenos dias   |   12:00-20:59 Buenas tardes   |   21:00-05:59 Buenas noches
// Sin dependencias de React ni de DOM para poder probarlo con node.

export type Period = 'manana' | 'tarde' | 'noche';

export const PERIOD_STARTS = [6, 12, 21] as const;

export function periodAt (h: number): Period {
	if (h >= 6 && h < 12) return 'manana';
	if (h >= 12 && h < 21) return 'tarde';
	return 'noche';
}

export function greetingFor (h: number, userName?: string | null): string {
	const who = userName ? `, ${userName}` : '';
	const p = periodAt(h);
	return (p === 'manana' ? 'Buenos días' : p === 'tarde' ? 'Buenas tardes' : 'Buenas noches') + who;
}

/** Milisegundos hasta el proximo cambio de franja (06:00, 12:00 o 21:00 locales). */
export function msUntilNextBoundary (now: Date): number {
	let best = Infinity;
	for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
		for (const h of PERIOD_STARTS) {
			const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, 0, 0, 0).getTime();
			if (t > now.getTime() && t - now.getTime() < best) best = t - now.getTime();
		}
	}
	return best;
}

/** Tope entre comprobaciones: cubre cambios de reloj/huso y timers largos que la TV retrasa. */
export const MAX_CHECK_MS = 60_000;

export interface Scheduler {
	now: () => Date;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
}

const realScheduler: Scheduler = {
	now: () => new Date(),
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>)
};

/**
 * Llama a `onChange(periodo)` cuando la franja local cambia (sin recargar). Un unico timer
 * encadenado: se arma para el proximo limite (maximo MAX_CHECK_MS) y se reevalua al disparar.
 * Devuelve la funcion de limpieza (cancela el timer pendiente).
 */
export function watchPeriod (onChange: (p: Period) => void, s: Scheduler = realScheduler): () => void {
	let last = periodAt(s.now().getHours());
	let id: unknown = null;
	let stopped = false;
	const arm = () => {
		const wait = Math.min(MAX_CHECK_MS, msUntilNextBoundary(s.now()) + 50);
		id = s.setTimeout(() => {
			if (stopped) return;
			const p = periodAt(s.now().getHours());
			if (p !== last) { last = p; onChange(p); }
			arm();
		}, Math.max(wait, 50));
	};
	arm();
	return () => { stopped = true; if (id !== null) s.clearTimeout(id); id = null; };
}
