import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';

/**
 * «¿Cómo está el tráfico?» y «¿hay algo en la A-8?»: las incidencias de la DGT en vivo
 * (obras, cortes, accidentes, retenciones, vehículos detenidos), con el feed DATEX II de
 * su Punto de Acceso Nacional (nap.dgt.es, gratis y sin clave). Solo lectura por red: el
 * modelo no da URL; elige carretera y, como mucho, provincia.
 */

const FEED = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v36.xml';
const CACHE_MS = 5 * 60_000;
const MAX_LINES = 10;
const ZONE = 'Europe/Madrid';
const DOWN = 'No pude consultar el tráfico de la DGT ahora mismo. Prueba otra vez en un rato.';

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
});

export interface TraficoDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

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

  return {
    name: 'trafico',
    label: 'Tráfico (DGT)',
    description:
      'Live traffic incidents in Spain from the DGT (roadworks, closures, accidents, slow traffic, stopped vehicles), no key. Use for «¿cómo está el tráfico?», «¿hay algo en la A-8?», «¿está cortada la AS-17?». Default area: the owner’s province (PA_TRAFICO_PROVINCIA, Asturias). Read-only.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
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
        const prov =
          provArg ||
          (road ? '' : (deps.env ?? process.env).PA_TRAFICO_PROVINCIA?.trim() || 'Asturias');
        const items = data.items.filter(
          (i) =>
            (!road || normCarretera(i.carretera) === normCarretera(road)) &&
            (!prov || i.provincia.split('/').some((p) => fold(p) === fold(prov))) &&
            !(i.inicio && i.inicio.getTime() > at.getTime()),
        );
        const roadName = road ? (items[0]?.carretera ?? road.toUpperCase()) : '';
        const provName = prov ? (items[0]?.provincia.split('/').at(-1) ?? titulo(prov)) : '';
        const donde = road ? `la ${roadName}${prov ? ` en ${provName}` : ''}` : provName;
        if (items.length === 0)
          return `Ahora mismo la DGT no tiene ninguna incidencia en ${donde}.`;
        // Los dos sentidos, o «carril cortado» y «circulación por otro carril» del mismo
        // tramo por las mismas obras, son una sola cosa para quien conduce.
        const porTramo = new Map<string, Incidencia>();
        for (const i of items) {
          const k = [i.carretera, i.km.map(kmText).join('-'), i.causa].join('|');
          const prev = porTramo.get(k);
          if (!prev || gravedad(i.que) < gravedad(prev.que) || (i.urgente && !prev.urgente))
            porTramo.set(k, i);
        }
        const unicas = [...porTramo.values()];
        const rank = (i: Incidencia) => (i.urgente ? 0 : CORTE.has(i.que) ? 1 : 2);
        unicas.sort(
          (a, b) => rank(a) - rank(b) || (b.inicio?.getTime() ?? 0) - (a.inicio?.getTime() ?? 0),
        );
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
