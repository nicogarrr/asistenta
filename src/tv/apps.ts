/**
 * Resolver el nombre que dice una persona ("Netflix", "youtube", "Disney+",
 * "RTVE Play") al appId real de webOS. Sin esto, `launch` con "youtube" o
 * "Netflix" mandaba un id que no existe y la tele contestaba con un error.
 *
 * Orden: id instalado exacto > alias conocido > titulo instalado (exacto, luego
 * prefijo/contenido, el mas corto). Si nada encaja, se devuelve tal cual: el
 * comportamiento de siempre (la tele decide).
 */

/** Minusculas, sin tildes ni signos: "Disney+" -> "disney", "Música" -> "musica". */
export function normalizeTvText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alias habituales -> id estable de la LG Content Store. */
export const APP_ALIASES: Record<string, string> = {
  netflix: 'netflix',
  youtube: 'youtube.leanback.v4',
  'you tube': 'youtube.leanback.v4',
  prime: 'amazon',
  'prime video': 'amazon',
  'amazon prime': 'amazon',
  'amazon prime video': 'amazon',
  amazon: 'amazon',
  disney: 'com.disney.disneyplus-prod',
  'disney plus': 'com.disney.disneyplus-prod',
  spotify: 'spotify-beehive',
  'apple tv': 'com.apple.appletv',
  'apple tv plus': 'com.apple.appletv',
  navegador: 'com.webos.app.browser',
  'el navegador': 'com.webos.app.browser',
  browser: 'com.webos.app.browser',
  inicio: 'com.webos.app.home',
  tdt: 'com.webos.app.livetv',
  antena: 'com.webos.app.livetv',
  'la tele': 'com.webos.app.livetv',
};

export interface ResolvedApp {
  id: string;
  /** Como se resolvio: para explicarlo y para tests. */
  how: 'id' | 'alias' | 'title' | 'raw';
  title?: string;
}

/** ¿Merece la pena pedir la lista de apps a la tele para resolver esto? */
export function needsAppLookup(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (q.includes('.')) return false; // ya parece un id real (com.x.y, youtube.leanback.v4)
  return APP_ALIASES[normalizeTvText(q)] === undefined;
}

export function resolveAppId(
  query: string,
  installed: Array<{ id: string; title: string }> | null,
): ResolvedApp {
  const q = query.trim();
  if (installed?.some((a) => a.id === q)) return { id: q, how: 'id' };
  const nq = normalizeTvText(q);
  const alias = APP_ALIASES[nq];
  if (alias) {
    const title = installed?.find((a) => a.id === alias)?.title;
    return { id: alias, how: 'alias', ...(title ? { title } : {}) };
  }
  if (installed && nq) {
    const titled = installed.map((a) => ({ ...a, n: normalizeTvText(a.title) }));
    const exact = titled.find((a) => a.n === nq);
    if (exact) return { id: exact.id, how: 'title', title: exact.title };
    const partial = titled
      .filter(
        (a) => a.n.startsWith(nq) || a.n.includes(` ${nq}`) || (nq.length >= 4 && a.n.includes(nq)),
      )
      .sort((a, b) => a.n.length - b.n.length);
    if (partial[0]) return { id: partial[0].id, how: 'title', title: partial[0].title };
  }
  return { id: q, how: 'raw' };
}
