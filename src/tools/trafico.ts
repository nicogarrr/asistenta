import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Store } from '../db.js';
import { writeFileReplacing } from '../fs-tmp.js';
import { log } from '../log.js';
import { type DeliverySetting, outputHash } from '../routine-delivery.js';

/**
 * «¿Cómo está el tráfico?» y «¿hay algo en la A-8?»: las incidencias de la DGT en vivo
 * (obras, cortes, accidentes, retenciones, vehículos detenidos), con el feed DATEX II de
 * su Punto de Acceso Nacional (nap.dgt.es, gratis y sin clave). Solo lectura por red: el
 * modelo no da URL; elige carretera y, como mucho, provincia.
 *
 * «Avísame si hay algo en la A-8» / «avísame si cortan la AS-II»: una rutina que mira cada
 * media hora entre las 6:00 y las 22:00 y solo escribe cuando aparece una incidencia NUEVA
 * del nivel elegido en esa carretera. Lo ya dicho (y lo que había al encender el aviso) se
 * apunta como visto y no se repite; que algo se despeje tampoco escribe.
 */

const FEED = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v36.xml';
const CACHE_MS = 5 * 60_000;
const MAX_LINES = 10;
const ZONE = 'Europe/Madrid';
const DOWN = 'No pude consultar el tráfico de la DGT ahora mismo. Prueba otra vez en un rato.';

/** El aviso mira cada media hora de 6:00 a 21:30: de día, cuando se conduce. */
export const AVISO_SCHEDULE = '*/30 6-21 * * *';
const AVISO_PREFIX = 'aviso tráfico: ';
/** Lo visto se olvida si lleva 12 h sin salir: si vuelve después, es otra vez noticia. */
const OLVIDO_MS = 12 * 3600_000;
/** «a-8 » → «A-8»: cómo se llama y se lista la carretera del aviso. */
const carreteraAviso = (s: string): string =>
  s.trim().toUpperCase().replace(/\s+/g, '-').slice(0, 20);
export const avisoRoutineName = (carretera: string): string =>
  `${AVISO_PREFIX}${carreteraAviso(carretera)}`;
export type Nivel = 'todo' | 'graves' | 'cortes';
const NIVEL_TEXTO: Record<Nivel, string> = {
  todo: 'cualquier incidencia nueva',
  graves: 'algo grave nuevo (un accidente, retenciones, un vehículo parado o un corte)',
  cortes: 'un corte nuevo',
};
/** Lo que dice el aviso cuando no hay nada nuevo: siempre igual, para que «solo si cambia» lo calle. */
export const sinNovedad = (carretera: string): string =>
  `Nada nuevo en la ${carreteraAviso(carretera)}.`;

/** Lo ya visto por cada aviso (clave del tramo → última vez visto), para no repetir. */
export interface VistosStore {
  get(
    scope: string,
    name: string,
  ): { sembrado: boolean; vistos: Record<string, string> } | undefined;
  set(
    scope: string,
    name: string,
    value: { sembrado: boolean; vistos: Record<string, string> } | undefined,
  ): void;
}

type VistosEntry = { sembrado: boolean; vistos: Record<string, string> };

/** Lo visto, en un JSON del estado local (sobrevive a reinicios). */
export class TraficoVistosStore implements VistosStore {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }
  #read(): Record<string, VistosEntry> {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, VistosEntry>)
        : {};
    } catch {
      return {};
    }
  }
  get(scope: string, name: string): VistosEntry | undefined {
    const e = this.#read()[`${scope}|${name}`];
    return e && typeof e === 'object' && e.vistos && typeof e.vistos === 'object'
      ? { sembrado: e.sembrado === true, vistos: e.vistos }
      : undefined;
  }
  set(scope: string, name: string, value: VistosEntry | undefined): void {
    const data = this.#read();
    if (value) data[`${scope}|${name}`] = value;
    else delete data[`${scope}|${name}`];
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    writeFileReplacing(this.#file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

/** Sin almacén (pruebas, otros sitios): lo visto vive en memoria. */
class MemoriaVistos implements VistosStore {
  readonly #m = new Map<string, VistosEntry>();
  get(scope: string, name: string) {
    return this.#m.get(`${scope}|${name}`);
  }
  set(scope: string, name: string, value: VistosEntry | undefined) {
    if (value) this.#m.set(`${scope}|${name}`, value);
    else this.#m.delete(`${scope}|${name}`);
  }
}

export interface Incidencia {
  carretera: string;
  provincia: string;
  municipio: string;
  /** Punto kilométrico, o inicio y fin del tramo, de menor a mayor. */
  km: number[];
  sentido: string;
  /** Qué pasa (carril cortado, tráfico lento…), en el vocabulario DATEX II. */
  que: string;
  /** Por qué (obras, desprendimientos, accidente…), en el vocabulario DATEX II. */
  causa: string;
  urgente: boolean;
  inicio: Date | null;
  fin: Date | null;
}

const QUE: Record<string, string> = {
  roadClosed: 'carretera cortada',
  carriagewayClosures: 'calzada cortada',
  laneClosures: 'carril cortado',
  doNotUseSpecifiedLanesOrCarriageways: 'carril cortado',
  intermittentShortTermClosures: 'cortes intermitentes',
  singleAlternateLineTraffic: 'paso alternativo',
  narrowLanes: 'carriles estrechos',
  lanesDeviated: 'carriles desviados',
  newRoadworksLayout: 'desvío por obras',
  useOfSpecifiedLanesOrCarriagewaysAllowed: 'circulación por otro carril',
  weightRestrictionInOperation: 'límite de peso',
  speedRestrictionInOperation: 'límite de velocidad',
  slowTraffic: 'tráfico lento',
  heavyTraffic: 'tráfico denso',
  queuingTraffic: 'retenciones',
  stationaryTraffic: 'tráfico parado',
  vehicleStuck: 'vehículo detenido',
  brokenDownVehicle: 'vehículo averiado',
  vehicleOnFire: 'vehículo ardiendo',
  vehicleWithOverwideLoad: 'transporte especial',
  roadSurfaceInPoorCondition: 'firme en mal estado',
  driveCarefully: 'precaución',
  accident: 'accidente',
  fog: 'niebla',
  visibilityReduced: 'poca visibilidad',
  snowfall: 'nieve',
  ice: 'hielo',
  strongWinds: 'viento fuerte',
  heavyRain: 'lluvia fuerte',
  objectOnTheRoad: 'obstáculo en la vía',
  obstructionOnTheRoad: 'obstáculo en la vía',
  spillageOnTheRoad: 'derrame en la vía',
  rockfalls: 'desprendimientos',
  flooding: 'inundación',
  forestFire: 'incendio forestal',
  avalanches: 'aludes',
  roadworks: 'obras',
};
const CAUSA: Record<string, string> = {
  roadworks: 'por obras',
  roadMaintenance: 'por obras',
  rockfalls: 'por desprendimientos',
  flooding: 'por inundación',
  forestFire: 'por un incendio forestal',
  avalanches: 'por aludes',
  environmentalObstruction: 'por un obstáculo en la vía',
  accident: 'por accidente',
  fog: 'por niebla',
  visibilityReduced: 'por poca visibilidad',
  snowfall: 'por nieve',
  ice: 'por hielo',
  strongWinds: 'por viento fuerte',
  heavyRain: 'por lluvia fuerte',
  poorEnvironment: 'por mal tiempo',
  objectOnTheRoad: 'por un obstáculo en la vía',
  obstructionOnTheRoad: 'por un obstáculo en la vía',
  obstruction: 'por un obstáculo en la vía',
  spillageOnTheRoad: 'por un derrame en la vía',
  vehicleStuck: 'por un vehículo detenido',
  vehicleObstruction: 'por un vehículo detenido',
};
/** Causas que no añaden nada a lo que ya se dice («firme en mal estado por daños en el firme»). */
const MISMA = new Set(['damagedRoadSurface', 'infrastructureDamageObstruction']);
/** Lo que conviene saber antes de salir: accidentes, retenciones, vehículos en la vía, cortes. */
const URGENTE = new Set(['accident', 'vehicleObstruction']);
/** Del mismo tramo y por la misma causa se dice solo lo más serio. */
const GRAVEDAD = [
  'roadClosed',
  'carriagewayClosures',
  'stationaryTraffic',
  'queuingTraffic',
  'laneClosures',
  'doNotUseSpecifiedLanesOrCarriageways',
  'intermittentShortTermClosures',
  'singleAlternateLineTraffic',
];
const gravedad = (que: string): number => {
  const i = GRAVEDAD.indexOf(que);
  return i < 0 ? GRAVEDAD.length : i;
};
const CORTE = new Set(['roadClosed', 'carriagewayClosures']);
/** El tramo de una incidencia: carretera, kilómetros y causa. */
const tramo = (i: Incidencia): string =>
  [i.carretera, i.km.map(kmText).join('-'), i.causa].join('|');
/** Las etiquetas «…Type» que dicen qué pasa, de la más concreta a la más general. */
const QUE_TAGS = [
  'abnormalTrafficType',
  'vehicleObstructionType',
  'roadOrCarriagewayOrLaneManagementType',
  'speedManagementType',
  'nonWeatherRelatedRoadConditionType',
  'generalInstructionToRoadUsersType',
  'poorEnvironmentType',
  'obstructionType',
  'accidentType',
  'environmentalObstructionType',
  'roadMaintenanceType',
];
const CAUSA_TAGS = [
  'environmentalObstructionType',
  'roadMaintenanceType',
  'infrastructureDamageType',
  'poorEnvironmentType',
  'obstructionType',
  'vehicleObstructionType',
  'accidentType',
];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENTITIES[e] ?? _m).trim();
/** Primer valor de una etiqueta (con cualquier prefijo de espacio de nombres). */
const first = (xml: string, tag: string): string => {
  const m = xml.match(new RegExp(`<\\w+:${tag}>([^<]*)</\\w+:${tag}>`));
  return m?.[1] ? decode(m[1]) : '';
};
const all = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<\\w+:${tag}>([^<]*)</\\w+:${tag}>`, 'g'))].map((m) =>
    decode(m[1] ?? ''),
  );
const fecha = (s: string): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** «a8», «A 8», «a-8» → «A8»: para comparar carreteras. */
export const normCarretera = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, '');

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();

/** Las incidencias del XML DATEX II de la DGT; un XML que no es el feed da lista vacía. */
export function parseIncidencias(xml: string): Incidencia[] {
  const out: Incidencia[] = [];
  for (const m of xml.matchAll(/<sit:situationRecord\b[\s\S]*?<\/sit:situationRecord>/g)) {
    const r = m[0];
    if (first(r, 'validityStatus') === 'suspended') continue;
    const carretera = first(r, 'roadName');
    if (!carretera) continue;
    const queTag = QUE_TAGS.find((t) => first(r, t));
    const que = queTag ? first(r, queTag) : '';
    const causaTag = CAUSA_TAGS.find((t) => first(r, t));
    const causaGeneral = first(r, 'causeType');
    const causa = (causaTag ? first(r, causaTag) : '') || causaGeneral;
    const km = all(r, 'kilometerPoint')
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .slice(0, 2)
      .sort((a, b) => a - b);
    const dest = first(r, 'roadDestination');
    out.push({
      carretera,
      provincia: first(r, 'province'),
      municipio: first(r, 'municipality'),
      km,
      sentido: dest && !fold(dest).startsWith('ambos') ? dest : '',
      que: que || causa,
      causa,
      urgente: URGENTE.has(causaGeneral) || /xsi:type="sit:AbnormalTraffic"/.test(r.slice(0, 200)),
      inicio: fecha(first(r, 'overallStartTime')),
      fin: fecha(first(r, 'overallEndTime')),
    });
  }
  return out;
}

const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'a']);
const titulo = (s: string): string =>
  s === s.toUpperCase()
    ? s
        .toLowerCase()
        .split(' ')
        .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ')
    : s;
const kmText = (n: number): string =>
  (n < 10 ? String(Math.round(n * 100) / 100) : String(Math.round(n * 10) / 10)).replace('.', ',');

const madrid = (d: Date) => {
  const p = new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return {
    dia: `${get('year')}-${get('month')}-${get('day')}`,
    fecha: `${get('day')} de ${get('month')}`,
    year: get('year'),
    hora: `${get('hour')}:${get('minute')}`,
  };
};
const cuando = (i: Incidencia, now: Date): string => {
  const hoy = madrid(now);
  if (i.fin && i.fin.getTime() > now.getTime()) {
    const f = madrid(i.fin);
    return f.dia === hoy.dia
      ? `hasta las ${f.hora}`
      : `hasta el ${f.fecha}${f.year !== hoy.year ? ` de ${f.year}` : ''}`;
  }
  if (!i.inicio) return '';
  const s = madrid(i.inicio);
  return s.dia === hoy.dia
    ? `desde las ${s.hora}`
    : `desde el ${s.fecha}${s.year !== hoy.year ? ` de ${s.year}` : ''}`;
};

function linea(i: Incidencia, now: Date, conProvincia: boolean): string {
  const km =
    i.km.length === 0
      ? ''
      : i.km.length === 1 || kmText(i.km[0] ?? 0) === kmText(i.km[1] ?? 0)
        ? `, km ${kmText(i.km[0] ?? 0)}`
        : `, km ${kmText(i.km[0] ?? 0)} a ${kmText(i.km[1] ?? 0)}`;
  const prov = conProvincia && fold(i.provincia) !== fold(i.municipio) ? i.provincia : '';
  const sitio = [i.municipio, prov].filter(Boolean).join(', ');
  const sentido = i.sentido ? `, sentido ${titulo(i.sentido)}` : '';
  const que = QUE[i.que] ?? 'incidencia';
  const porque = i.causa !== i.que && !MISMA.has(i.causa) ? CAUSA[i.causa] : undefined;
  const what =
    porque && !que.includes(porque.replace(/^por (un |una )?/, '')) ? `${que} ${porque}` : que;
  const when = cuando(i, now);
  return `• ${i.carretera}${km}${sitio ? ` (${sitio})` : ''}${sentido}: ${what}${when ? `, ${when}` : ''}.`;
}

const Params = Type.Object({
  carretera: Type.Optional(
    Type.String({
      description: 'Road as the DGT names it (A-8, AS-17, N-634). Omit for the whole province.',
    }),
  ),
  provincia: Type.Optional(
    Type.String({
      description:
        'Spanish province (e.g. Asturias, Cantabria). Omit to use the owner’s (PA_TRAFICO_PROVINCIA, default Asturias); with carretera, omit to search all of Spain.',
    }),
  ),
  aviso: Type.Optional(
    Type.Union([Type.Literal('activar'), Type.Literal('desactivar'), Type.Literal('ver')], {
      description:
        'Only when the owner asks to be told about a road: activar (with carretera) a watch that writes only when a NEW incident appears; desactivar (with carretera for one, without for all); ver lists them.',
    }),
  ),
  nivel: Type.Optional(
    Type.Union([Type.Literal('todo'), Type.Literal('graves'), Type.Literal('cortes')], {
      description:
        'For aviso=activar: todo («si hay algo»), graves (accidents, queues, stopped vehicles, closures) or cortes («si cortan la carretera»). Default todo.',
    }),
  ),
  rutina: Type.Optional(
    Type.Boolean({
      description: 'Only set by the traffic watch routine itself. Never set it otherwise.',
    }),
  ),
});

export interface TraficoDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Para el aviso (rutinas). Sin esto, el aviso no se ofrece. */
  store?: Pick<Store, 'saveRoutine' | 'deleteRoutine' | 'getRoutine' | 'listRoutines'>;
  scopeOf?: () => string;
  sync?: () => void;
  /** «Solo si cambia» para la rutina del aviso: sin nada nuevo no se escribe. */
  delivery?: {
    set(scope: string, name: string, setting: DeliverySetting): void;
    commit(scope: string, name: string, hash: string): void;
  };
  /** Lo ya avisado por cada aviso. Sin esto, en memoria. */
  vistos?: VistosStore;
}

const ESPANA = new Set(['espana', 'toda espana', 'todo el pais', 'toda la peninsula']);
const NIVELES: readonly Nivel[] = ['todo', 'graves', 'cortes'];

export function createTraficoTool(deps: TraficoDeps = {}): AgentTool<typeof Params> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  let cache: { at: number; items: Incidencia[]; publicado: Date | null } | null = null;

  const feed = async () => {
    if (cache && now().getTime() - cache.at < CACHE_MS) return cache;
    const res = await fetchFn(FEED, {
      headers: { accept: 'application/xml, text/xml' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!/<d2:payload\b/.test(xml)) throw new Error('no es el feed DATEX II');
    cache = {
      at: now().getTime(),
      items: parseIncidencias(xml),
      publicado: fecha(first(xml, 'publicationTime')),
    };
    return cache;
  };

  /** Filtra por carretera/provincia y deja una incidencia por tramo (la más seria). */
  const seleccion = (items: Incidencia[], road: string, prov: string, at: Date): Incidencia[] => {
    const elegidas = items.filter(
      (i) =>
        (!road || normCarretera(i.carretera) === normCarretera(road)) &&
        (!prov || i.provincia.split('/').some((p) => fold(p) === fold(prov))) &&
        !(i.inicio && i.inicio.getTime() > at.getTime()),
    );
    // Los dos sentidos, o «carril cortado» y «circulación por otro carril» del mismo
    // tramo por las mismas obras, son una sola cosa para quien conduce.
    const porTramo = new Map<string, Incidencia>();
    for (const i of elegidas) {
      const k = tramo(i);
      const prev = porTramo.get(k);
      if (!prev || gravedad(i.que) < gravedad(prev.que) || (i.urgente && !prev.urgente))
        porTramo.set(k, i);
    }
    const unicas = [...porTramo.values()];
    const rank = (i: Incidencia) => (i.urgente ? 0 : CORTE.has(i.que) ? 1 : 2);
    unicas.sort(
      (a, b) => rank(a) - rank(b) || (b.inicio?.getTime() ?? 0) - (a.inicio?.getTime() ?? 0),
    );
    return unicas;
  };
  const delNivel = (items: Incidencia[], nivel: Nivel): Incidencia[] =>
    nivel === 'todo'
      ? items
      : items.filter((i) => CORTE.has(i.que) || (nivel === 'graves' && i.urgente));
  /** Para quien conduce: la misma carretera, tramo, causa y medida es la misma incidencia. */
  const clave = (i: Incidencia): string => `${tramo(i)}|${i.que}`;

  const provDueno = (): string =>
    (deps.env ?? process.env).PA_TRAFICO_PROVINCIA?.trim() || 'Asturias';
  const provDelAviso = (arg: string | undefined): string => {
    const p = arg?.trim() ?? '';
    if (ESPANA.has(fold(p))) return '';
    return p ? (p === p.toLowerCase() ? titulo(p.toUpperCase()) : p) : provDueno();
  };
  const vistos = deps.vistos ?? new MemoriaVistos();

  const avisos = (scope: string) =>
    (deps.store?.listRoutines(scope) ?? []).filter((r) => r.name.startsWith(AVISO_PREFIX));
  const describeAviso = (prompt: string | null, name: string): string => {
    const road = name.slice(AVISO_PREFIX.length);
    const prov = prompt?.match(/provincia «([^»]*)»/)?.[1] ?? '';
    const nivel = (prompt?.match(/nivel «(todo|graves|cortes)»/)?.[1] ?? 'todo') as Nivel;
    const que = nivel === 'cortes' ? 'cortes' : nivel === 'graves' ? 'lo grave' : 'todo';
    const donde = !prov ? '' : ESPANA.has(fold(prov)) ? ' en toda España' : ` en ${prov}`;
    return `la ${road}${donde} (${que})`;
  };
  const y = (xs: string[]): string =>
    xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`;

  /** Marca como visto lo que hay ahora y olvida lo que lleva 12 h sin salir. */
  const apuntar = (
    prev: Record<string, string>,
    actuales: Incidencia[],
    at: Date,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(prev)) {
      const t = Date.parse(v);
      if (Number.isFinite(t) && at.getTime() - t < OLVIDO_MS) out[k] = v;
    }
    for (const i of actuales) out[clave(i)] = at.toISOString();
    return out;
  };

  const aviso = async (
    mode: 'activar' | 'desactivar' | 'ver',
    carretera: string | undefined,
    provincia: string | undefined,
    nivelArg: string | undefined,
  ): Promise<string> => {
    const { store, scopeOf } = deps;
    if (!store || !scopeOf) return 'El aviso del tráfico no está disponible aquí.';
    const scope = scopeOf();
    const road = carretera?.trim() ?? '';
    if (mode === 'ver') {
      const rs = avisos(scope);
      return rs.length === 0
        ? 'No tienes ningún aviso del tráfico.'
        : `Vigilo el tráfico (cada media hora, de 6:00 a 22:00) en ${y(rs.map((r) => describeAviso(r.prompt, r.name)))}.`;
    }
    if (mode === 'desactivar') {
      const rs = avisos(scope).filter(
        (r) => !road || normCarretera(r.name.slice(AVISO_PREFIX.length)) === normCarretera(road),
      );
      if (rs.length === 0)
        return road
          ? `No tenía ningún aviso del tráfico en la ${carreteraAviso(road)}.`
          : 'No tenías ningún aviso del tráfico.';
      for (const r of rs) {
        store.deleteRoutine(scope, r.name);
        vistos.set(scope, r.name, undefined);
      }
      deps.sync?.();
      return `Hecho: ya no vigilo el tráfico en ${y(rs.map((r) => `la ${r.name.slice(AVISO_PREFIX.length)}`))}.`;
    }
    if (!normCarretera(road))
      return '¿De qué carretera te aviso? Dímela como la nombra la DGT, por ejemplo la A-8 o la AS-II.';
    const nivel: Nivel = NIVELES.includes(nivelArg as Nivel) ? (nivelArg as Nivel) : 'todo';
    const prov = provDelAviso(provincia);
    const name = avisoRoutineName(road);
    // Una carretera, un aviso: «avísame si cortan la a8» sustituye al de la A-8.
    for (const r of avisos(scope))
      if (normCarretera(r.name.slice(AVISO_PREFIX.length)) === normCarretera(road)) {
        store.deleteRoutine(scope, r.name);
        vistos.set(scope, r.name, undefined);
      }
    const at = now();
    let ahora: Incidencia[] | null = null;
    try {
      ahora = delNivel(seleccion((await feed()).items, road, prov, at), nivel);
    } catch (err) {
      log.warn('trafico: fallo al consultar la DGT al encender el aviso', { err: String(err) });
    }
    store.saveRoutine({
      scope,
      name,
      kind: 'schedule',
      schedule: AVISO_SCHEDULE,
      prompt: `Usa la herramienta trafico con carretera «${carreteraAviso(road)}», provincia «${prov || 'España'}», nivel «${nivel}» y rutina true, y responde solo con el texto que te devuelva, tal cual, sin añadir nada.`,
      enabled: true,
    });
    // Lo que ya hay no es noticia: se apunta como visto. Si la DGT no contesta ahora, la
    // primera vuelta de la rutina lo apunta en silencio.
    vistos.set(scope, name, {
      sembrado: ahora !== null,
      vistos: ahora ? apuntar({}, ahora, at) : {},
    });
    deps.delivery?.set(scope, name, { target: 'chat', soloSiCambia: true });
    deps.delivery?.commit(scope, name, outputHash(sinNovedad(road)));
    deps.sync?.();
    const donde = `la ${carreteraAviso(road)}${prov ? ` en ${prov}` : ' en toda España'}`;
    const n = ahora?.length ?? 0;
    const hay =
      ahora === null
        ? ''
        : n === 0
          ? ' Ahora mismo no hay nada.'
          : ` Ahora mismo hay ${n === 1 ? 'una' : n}; ${n === 1 ? 'de esa' : 'de esas'} no te aviso.`;
    return `Hecho: miro ${donde} cada media hora, de 6:00 a 22:00, y solo te escribo si aparece ${NIVEL_TEXTO[nivel]}.${hay} Para quitarlo, dime «quita el aviso del tráfico».`;
  };

  /** La rutina: solo lo nuevo; sin nada nuevo, el texto fijo pasa a ser lo último dicho. */
  const enRutina = async (
    road: string,
    provincia: string | undefined,
    nivelArg: string | undefined,
  ): Promise<string> => {
    const nivel: Nivel = NIVELES.includes(nivelArg as Nivel) ? (nivelArg as Nivel) : 'todo';
    const prov = provDelAviso(provincia);
    const scope = deps.scopeOf?.() ?? '';
    const name = avisoRoutineName(road);
    const callar = (): string => {
      const text = sinNovedad(road);
      const { store, delivery } = deps;
      if (store && deps.scopeOf && delivery && store.getRoutine(scope, name))
        delivery.commit(scope, name, outputHash(text));
      return text;
    };
    const at = now();
    let actuales: Incidencia[];
    try {
      actuales = delNivel(seleccion((await feed()).items, road, prov, at), nivel);
    } catch (err) {
      // Una DGT caída no es una novedad: se calla y se mira en la próxima vuelta.
      log.warn('trafico: fallo al consultar la DGT en el aviso', { err: String(err) });
      return callar();
    }
    const prev = vistos.get(scope, name);
    const nuevas = prev?.sembrado ? actuales.filter((i) => !(clave(i) in prev.vistos)) : [];
    vistos.set(scope, name, { sembrado: true, vistos: apuntar(prev?.vistos ?? {}, actuales, at) });
    if (nuevas.length === 0) return callar();
    const n = nuevas.length;
    const donde = `la ${carreteraAviso(road)}${prov ? ` (${prov})` : ''}`;
    const head = `Tráfico: ${n === 1 ? 'novedad' : `${n} novedades`} en ${donde}.`;
    const lines = nuevas.slice(0, MAX_LINES).map((i) => linea(i, at, !prov));
    const more = n > MAX_LINES ? `\nY ${n - MAX_LINES} más.` : '';
    return `${head}\n${lines.join('\n')}${more}`;
  };

  return {
    name: 'trafico',
    label: 'Tráfico (DGT)',
    description:
      'Live traffic incidents in Spain from the DGT (roadworks, closures, accidents, slow traffic, stopped vehicles), no key. Use for «¿cómo está el tráfico?», «¿hay algo en la A-8?», «¿está cortada la AS-17?». Default area: the owner’s province (PA_TRAFICO_PROVINCIA, Asturias). Read-only. aviso=activar (with carretera, nivel) / desactivar / ver only when the owner asks to be told about a road («avísame si cortan la AS-II»).',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        if (args.aviso) return aviso(args.aviso, args.carretera, args.provincia, args.nivel);
        if (args.rutina === true && args.carretera?.trim())
          return enRutina(args.carretera, args.provincia, args.nivel);
        let data: Awaited<ReturnType<typeof feed>>;
        try {
          data = await feed();
        } catch (err) {
          log.warn('trafico: fallo al consultar la DGT', { err: String(err) });
          return DOWN;
        }
        const at = now();
        const road = args.carretera?.trim() ?? '';
        const provArg = args.provincia?.trim() ?? '';
        const prov = provArg || (road ? '' : provDueno());
        const unicas = seleccion(data.items, road, prov, at);
        const roadName = road ? (unicas[0]?.carretera ?? road.toUpperCase()) : '';
        const provName = prov ? (unicas[0]?.provincia.split('/').at(-1) ?? titulo(prov)) : '';
        const donde = road ? `la ${roadName}${prov ? ` en ${provName}` : ''}` : provName;
        if (unicas.length === 0)
          return `Ahora mismo la DGT no tiene ninguna incidencia en ${donde}.`;
        const hora = data.publicado ? `DGT, ${madrid(data.publicado).hora}` : 'DGT';
        const n = unicas.length;
        const head = `Tráfico ahora en ${donde} (${hora}): ${n} ${n === 1 ? 'incidencia' : 'incidencias'}.`;
        const lines = unicas.slice(0, MAX_LINES).map((i) => linea(i, at, !prov));
        const more = n > MAX_LINES ? `\nY ${n - MAX_LINES} más.` : '';
        return `${head}\n${lines.join('\n')}${more}`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
