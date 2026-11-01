import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { localDay } from '../datecontext.js';
import type { Store } from '../db.js';
import { log } from '../log.js';
import { type DeliverySetting, outputHash } from '../routine-delivery.js';

/**
 * «¿Ha salido algo en el BOE sobre X?» y «avísame si sale algo en el BOE sobre X»: el
 * sumario del día con la API de datos abiertos del BOE (gratis y sin clave). Solo lectura
 * por red: el modelo no da URL; elige palabras y, como mucho, una fecha. El aviso es una
 * rutina de lunes a sábado a las 9:00 que solo escribe cuando sale algo.
 */

const API = 'https://www.boe.es/datosabiertos/api/boe/sumario';
const CACHE_MS = 30 * 60_000;
const MAX_ITEMS = 8;
const MAX_TITLE = 240;
const DOWN = 'No pude consultar el BOE ahora mismo. Prueba otra vez en un rato.';

/** El BOE sale de lunes a sábado de madrugada: el aviso mira a las 9:00. */
export const AVISO_SCHEDULE = '0 9 * * 1-6';
const AVISO_PREFIX = 'aviso boe: ';
const normTema = (q: string): string => q.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 80);
export const avisoRoutineName = (tema: string): string => `${AVISO_PREFIX}${normTema(tema)}`;

/** Lo que dice el aviso un día sin nada: siempre igual, para que «solo si cambia» lo calle. */
export const sinNovedad = (tema: string): string =>
  `En el BOE de hoy no ha salido nada sobre «${tema}».`;

/**
 * Lo que dice el aviso si el BOE no responde: nadie ha preguntado, así que nada de «prueba
 * otra vez». Siempre igual, para que «solo si cambia» lo diga una vez por caída.
 */
export const caidoEnRutina = (tema: string): string =>
  `Hoy no he podido mirar el BOE por «${tema}»: no respondía. Sigo mirando cada mañana; si te corre prisa, está en boe.es.`;

export interface BoeItem {
  id: string;
  titulo: string;
  url: string;
  seccion: string;
  seccionNombre: string;
  departamento: string;
  epigrafe: string;
}

const asList = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object',
  );
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

const SMALL = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'y',
  'e',
  'o',
  'para',
  'por',
  'en',
  'a',
  'al',
]);
/** «MINISTERIO DE AGRICULTURA, PESCA Y ALIMENTACIÓN» → «Ministerio de Agricultura, Pesca y Alimentación». */
const nombre = (s: string): string =>
  s
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

/**
 * Las publicaciones del sumario. La API pasa su XML a JSON, así que una lista de un solo
 * elemento llega como objeto suelto: todo se lee como lista.
 */
export function parseSumario(body: unknown): BoeItem[] {
  const out: BoeItem[] = [];
  const sumario = (body as { data?: { sumario?: { diario?: unknown } } })?.data?.sumario;
  for (const diario of asList(sumario?.diario)) {
    for (const sec of asList(diario.seccion)) {
      for (const dep of asList(sec.departamento)) {
        const push = (it: Record<string, unknown>, epigrafe: string) => {
          const id = str(it.identificador);
          const titulo = str(it.titulo).trim();
          if (!id || !titulo) return;
          const pdf = str((it.url_pdf as { texto?: unknown } | undefined)?.texto);
          out.push({
            id,
            titulo,
            url: str(it.url_html) || pdf || `https://www.boe.es/buscar/doc.php?id=${id}`,
            seccion: str(sec.codigo),
            seccionNombre: str(sec.nombre),
            departamento: nombre(str(dep.nombre)),
            epigrafe,
          });
        };
        for (const it of asList(dep.item)) push(it, '');
        for (const ep of asList(dep.epigrafe))
          for (const it of asList(ep.item)) push(it, str(ep.nombre));
      }
    }
  }
  return out;
}

const STOP = new Set([
  'a',
  'al',
  'algo',
  'boe',
  'con',
  'cosa',
  'cosas',
  'de',
  'del',
  'e',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'o',
  'para',
  'por',
  'que',
  'se',
  'sobre',
  'su',
  'sus',
  'tema',
  'u',
  'un',
  'una',
  'unas',
  'unos',
  'y',
]);
const words = (s: string): string[] =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** «oposiciones» → «oposicion», «plazas» → «plaza»: se compara por el principio de palabra. */
const stem = (w: string): string =>
  w.length > 4 && w.endsWith('es')
    ? w.slice(0, -2)
    : w.length > 3 && w.endsWith('s')
      ? w.slice(0, -1)
      : w;
const terms = (q: string): string[] =>
  words(q)
    .filter((w) => !STOP.has(w))
    .map(stem);

/** Todas las palabras de la búsqueda están en el título, el organismo o el apartado. */
export function coincide(item: BoeItem, q: string): boolean {
  const want = terms(q);
  if (want.length === 0) return false;
  const have = words(`${item.titulo} ${item.departamento} ${item.epigrafe} ${item.seccionNombre}`);
  return want.every((t) => have.some((w) => w.startsWith(t)));
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const asDate = (day: string): Date => new Date(`${day}T12:00:00Z`);
const diaLargo = (day: string): string => {
  const d = asDate(day);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
};
const sumarioUrl = (day: string): string =>
  `https://www.boe.es/boe/dias/${day.replaceAll('-', '/')}/`;
const recorta = (s: string): string => {
  if (s.length <= MAX_TITLE) return s;
  const cut = s.slice(0, MAX_TITLE);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : MAX_TITLE)}…`;
};
const linea = (i: BoeItem): string =>
  `• ${recorta(i.titulo)}${i.departamento ? ` (${i.departamento})` : ''}\n  ${i.url}`;

/** Cuántas de cada tipo, en el orden del BOE. */
const GRUPOS: { match: (s: string) => boolean; uno: string; varios: string }[] = [
  { match: (s) => s === '1', uno: 'disposición general', varios: 'disposiciones generales' },
  { match: (s) => s === '2A', uno: 'nombramiento', varios: 'nombramientos' },
  { match: (s) => s === '2B', uno: 'oposición o concurso', varios: 'oposiciones y concursos' },
  { match: (s) => s === '3', uno: 'otra disposición', varios: 'otras disposiciones' },
  { match: (s) => s === '4', uno: 'edicto judicial', varios: 'edictos judiciales' },
  { match: (s) => s.startsWith('5'), uno: 'anuncio', varios: 'anuncios' },
  {
    match: (s) => s === 'T',
    uno: 'sentencia del Constitucional',
    varios: 'sentencias del Constitucional',
  },
];
const y = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
function recuento(items: BoeItem[]): string {
  const parts: string[] = [];
  let resto = items.length;
  for (const g of GRUPOS) {
    const n = items.filter((i) => g.match(i.seccion)).length;
    if (n === 0) continue;
    resto -= n;
    parts.push(`${n} ${n === 1 ? g.uno : g.varios}`);
  }
  if (resto > 0) parts.push(`${resto} ${resto === 1 ? 'otra publicación' : 'otras publicaciones'}`);
  return y(parts);
}

const Params = Type.Object({
  buscar: Type.Optional(
    Type.String({
      description:
        'Words to look for in the day’s BOE (titles, issuing body, heading), e.g. «ayudas vivienda», «oposiciones Gijón». Omit for a summary of the day.',
    }),
  ),
  fecha: Type.Optional(Type.String({ description: 'Day as YYYY-MM-DD. Omit for today (Madrid).' })),
  aviso: Type.Optional(
    Type.Union([Type.Literal('activar'), Type.Literal('desactivar'), Type.Literal('ver')], {
      description:
        'Only when the owner asks: activar (with buscar) a daily BOE watch that writes only when something matches; desactivar (with buscar for one, without for all); ver lists them.',
    }),
  ),
  rutina: Type.Optional(
    Type.Boolean({
      description: 'Only set by the BOE watch routine itself. Never set it otherwise.',
    }),
  ),
});

export interface BoeDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** Para el aviso (rutinas). Sin esto, el aviso no se ofrece. */
  store?: Pick<Store, 'saveRoutine' | 'deleteRoutine' | 'getRoutine' | 'listRoutines'>;
  scopeOf?: () => string;
  sync?: () => void;
  /** «Solo si cambia» para la rutina del aviso: un día sin nada no se escribe. */
  delivery?: {
    set(scope: string, name: string, setting: DeliverySetting): void;
    commit(scope: string, name: string, hash: string): void;
  };
}

class NoPublicado extends Error {}

export function createBoeTool(deps: BoeDeps = {}): AgentTool<typeof Params> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; items: BoeItem[] }>();

  const sumario = async (day: string): Promise<BoeItem[]> => {
    const hit = cache.get(day);
    if (hit && now().getTime() - hit.at < CACHE_MS) return hit.items;
    const res = await fetchFn(`${API}/${day.replaceAll('-', '')}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 12_000),
    });
    if (res.status === 404) throw new NoPublicado();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseSumario((await res.json()) as unknown);
    if (cache.size > 10) cache.clear();
    cache.set(day, { at: now().getTime(), items });
    return items;
  };

  const avisos = (scope: string): string[] =>
    (deps.store?.listRoutines(scope) ?? [])
      .map((r) => r.name)
      .filter((n) => n.startsWith(AVISO_PREFIX))
      .map((n) => n.slice(AVISO_PREFIX.length));
  const lista = (temas: string[]): string => y(temas.map((t) => `«${t}»`));

  const aviso = (mode: 'activar' | 'desactivar' | 'ver', buscar: string | undefined): string => {
    const { store, scopeOf } = deps;
    if (!store || !scopeOf) return 'El aviso del BOE no está disponible aquí.';
    const scope = scopeOf();
    const tema = normTema(buscar ?? '');
    if (mode === 'ver') {
      const temas = avisos(scope);
      return temas.length === 0
        ? 'No tienes ningún aviso del BOE.'
        : `Vigilo el BOE (de lunes a sábado a las 9:00) sobre: ${lista(temas)}.`;
    }
    if (mode === 'desactivar') {
      const temas = avisos(scope).filter((t) => !tema || fold(t) === fold(tema));
      if (temas.length === 0)
        return tema
          ? `No tenía ningún aviso del BOE sobre «${tema}».`
          : 'No tenías ningún aviso del BOE.';
      for (const t of temas) store.deleteRoutine(scope, avisoRoutineName(t));
      deps.sync?.();
      return `Hecho: ya no vigilo el BOE sobre ${lista(temas)}.`;
    }
    if (terms(tema).length === 0)
      return '¿Sobre qué quieres que vigile el BOE? Dime una o varias palabras, por ejemplo «ayudas vivienda» u «oposiciones Gijón».';
    const name = avisoRoutineName(tema);
    store.saveRoutine({
      scope,
      name,
      kind: 'schedule',
      schedule: AVISO_SCHEDULE,
      prompt: `Usa la herramienta boe con buscar «${tema}» y rutina true y responde solo con el texto que te devuelva, tal cual, sin añadir nada.`,
      enabled: true,
    });
    deps.delivery?.set(scope, name, { target: 'chat', soloSiCambia: true });
    deps.delivery?.commit(scope, name, outputHash(sinNovedad(tema)));
    deps.sync?.();
    return `Hecho: de lunes a sábado a las 9:00 miro el BOE y solo te escribo si sale algo sobre «${tema}». Para quitarlo, dime «quita el aviso del BOE».`;
  };

  /** La rutina, un día sin nada: «nada» pasa a ser lo último dicho, así no se repite. */
  const nadaEnRutina = (tema: string): string => {
    const text = sinNovedad(tema);
    const { store, scopeOf, delivery } = deps;
    if (store && scopeOf && delivery) {
      const scope = scopeOf();
      const name = avisoRoutineName(tema);
      if (store.getRoutine(scope, name)) delivery.commit(scope, name, outputHash(text));
    }
    return text;
  };

  return {
    name: 'boe',
    label: 'BOE',
    description:
      'Spain’s official gazette (BOE) for a given day, from its open-data API (no key). Use for «¿ha salido algo en el BOE sobre X?», «¿qué trae hoy el BOE?». Read-only. aviso=activar (with buscar) / desactivar / ver only when the owner asks to be told when something about a topic appears in the BOE.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        if (args.aviso) return aviso(args.aviso, args.buscar);
        const today = localDay(now());
        const day = args.fecha?.trim() || today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(asDate(day).getTime()))
          return 'Dime la fecha como AAAA-MM-DD, por ejemplo 2026-10-30.';
        const rutina = args.rutina === true && !!args.buscar;
        const q =
          (rutina ? normTema(args.buscar ?? '') : args.buscar?.trim().replace(/\s+/g, ' ')) ?? '';
        if (args.buscar !== undefined && terms(q).length === 0)
          return '¿Qué busco en el BOE? Dime una o varias palabras, por ejemplo «ayudas vivienda».';
        const esHoy = day === today;
        if (asDate(day).getUTCDay() === 0)
          return rutina ? nadaEnRutina(q) : 'Los domingos no se publica el BOE.';
        if (day > today) return `El BOE del ${diaLargo(day)} aún no ha salido.`;
        let items: BoeItem[];
        try {
          items = await sumario(day);
        } catch (err) {
          if (err instanceof NoPublicado) {
            if (rutina) return nadaEnRutina(q);
            return esHoy || day === localDay(now().getTime() - 86_400_000)
              ? `Aún no encuentro el BOE del ${diaLargo(day)}: puede que no esté publicado todavía.`
              : `No encuentro el BOE del ${diaLargo(day)}.`;
          }
          log.warn('boe: fallo al consultar', { err: String(err) });
          return rutina ? caidoEnRutina(q) : DOWN;
        }
        const del = esHoy ? `de hoy, ${diaLargo(day)},` : `del ${diaLargo(day)}`;
        if (!q) {
          if (items.length === 0) return `El BOE ${del.replace(/,$/, '')} no trae publicaciones.`;
          const generales = items.filter((i) => i.seccion === '1');
          const out = [`El BOE ${del} trae ${items.length} publicaciones: ${recuento(items)}.`];
          if (generales.length > 0)
            out.push(
              `Disposiciones generales:\n${generales.slice(0, MAX_ITEMS).map(linea).join('\n')}`,
            );
          out.push(`Todo el sumario: ${sumarioUrl(day)}`);
          return out.join('\n\n');
        }
        const hits = items.filter((i) => coincide(i, q));
        if (hits.length === 0)
          return esHoy
            ? rutina
              ? nadaEnRutina(q)
              : sinNovedad(q)
            : `En el BOE del ${diaLargo(day)} no ha salido nada sobre «${q}».`;
        const head = `En el BOE ${del} hay ${hits.length} ${hits.length === 1 ? 'cosa' : 'cosas'} sobre «${q}»:`;
        const body = hits.slice(0, MAX_ITEMS).map(linea).join('\n');
        const more =
          hits.length > MAX_ITEMS
            ? `\nY ${hits.length - MAX_ITEMS} más en el sumario: ${sumarioUrl(day)}`
            : '';
        return `${head}\n${body}${more}`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
