// Próximos lanzamientos (ASTS / SpaceX) — Launch Library 2 (The Space Devs),
// API gratuita sin clave. Se muestra con fuente y fecha; si falla, se oculta.
const API = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/';
const CACHE_KEY = 'launch-next-v1';
const CACHE_MS = 6 * 3600_000;

export interface NextLaunch {
	name: string;       // nombre de la misión
	net: string;        // fecha/hora ISO estimada de lanzamiento
	provider: string;   // empresa (p. ej. SpaceX)
	fetchedAt: string;  // cuándo lo descargamos (para "actualizado")
}

function loadCache (): NextLaunch | null {
	try {
		const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as {ts: number; launch: NextLaunch} | null;
		if (c && c.launch && Date.now() - c.ts < CACHE_MS) return c.launch;
	} catch { /* noop */ }
	return null;
}

async function search (q: string): Promise<NextLaunch | null> {
	const r = await fetch(`${API}?limit=1&mode=detailed&search=${encodeURIComponent(q)}`);
	if (!r.ok) throw new Error(`launch ${r.status}`);
	const d = await r.json();
	const l = d?.results?.[0];
	if (!l) return null;
	return {
		name: String(l.name || ''),
		net: String(l.net || ''),
		provider: String(l.launch_service_provider?.name || ''),
		fetchedAt: new Date().toISOString()
	};
}

/** El lanzamiento más próximo entre ASTS (BlueBird) y SpaceX. null si falla. */
export async function fetchNextLaunch (): Promise<NextLaunch | null> {
	const cached = loadCache();
	if (cached) return cached;
	try {
		const [asts, spacex] = await Promise.all([
			search('BlueBird').catch(() => null),
			search('SpaceX').catch(() => null)
		]);
		const both = [asts, spacex].filter(Boolean) as NextLaunch[];
		if (!both.length) return null;
		both.sort((a, b) => a.net.localeCompare(b.net));
		const next = both[0];
		try { localStorage.setItem(CACHE_KEY, JSON.stringify({ts: Date.now(), launch: next})); } catch { /* noop */ }
		return next;
	} catch {
		return null;
	}
}

/** "12 nov · 18:30" en horario local de la TV. */
export function formatNet (iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return '';
	return d.toLocaleString([], {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}
