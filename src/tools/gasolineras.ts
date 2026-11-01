import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Store } from '../db.js';
import { log } from '../log.js';
import { type DeliverySetting, outputHash } from '../routine-delivery.js';

/**
 * «¿Dónde echo gasolina más barata?»: las gasolineras más baratas del municipio configurado
 * (por defecto Gijón), con la API oficial del Ministerio (precios que actualiza cada media
 * hora; gratis y sin clave). Solo lectura por red: el modelo no da URL; elige combustible y,
 * como mucho, un umbral. El aviso «si baja de 1,40» es opcional y lo enciende el dueño con
 * sus palabras: una rutina que mira dos veces al día y solo escribe cuando hay novedad.
 */

const API = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes';
const CACHE_MS = 30 * 60_000;
const MUNICIPIOS_CACHE_MS = 7 * 86_400_000;
/** Gijón: el municipio por defecto (ID del Ministerio), sin consultar la lista. */
const GIJON = { id: '4987', name: 'Gijón' };

export const COMBUSTIBLES = {
  diesel: { field: 'Precio Gasoleo A', label: 'Diésel' },
  diesel_premium: { field: 'Precio Gasoleo Premium', label: 'Diésel premium' },
  gasolina95: { field: 'Precio Gasolina 95 E5', label: 'Gasolina 95' },
  gasolina98: { field: 'Precio Gasolina 98 E5', label: 'Gasolina 98' },
  glp: { field: 'Precio Gases licuados del petróleo', label: 'GLP (autogás)' },
} as const;
export type Combustible = keyof typeof COMBUSTIBLES;
const isCombustible = (v: string): v is Combustible => v in COMBUSTIBLES;

/** El aviso «si baja de X» mira a las 9:00 y a las 19:00. */
export const AVISO_SCHEDULE = '0 9,19 * * *';
export const avisoRoutineName = (c: Combustible): string =>
  `aviso gasolineras: ${COMBUSTIBLES[c].label.toLowerCase()}`;

export interface Gasolinera {
  marca: string;
  direccion: string;
  localidad: string;
  horario: string;
  precio: number;
}

const Params = Type.Object({
  combustible: Type.Optional(
    Type.Union(
      [
        Type.Literal('diesel'),
        Type.Literal('diesel_premium'),
        Type.Literal('gasolina95'),
        Type.Literal('gasolina98'),
        Type.Literal('glp'),
      ],
      {
        description: 'Fuel. Omit to use the owner’s default (PA_CARBURANTE) or show diesel and 95.',
      },
    ),
  ),
  cuantas: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 10, description: 'How many stations (default 5).' }),
  ),
  umbral: Type.Optional(
    Type.Number({ description: 'Price in €/L: only stations at or below it (e.g. 1.40).' }),
  ),
  aviso: Type.Optional(
    Type.Union([Type.Literal('activar'), Type.Literal('desactivar')], {
      description:
        'Only when the owner asks: turn on/off an alert (checked at 9:00 and 19:00) when the fuel drops to umbral or below.',
    }),
  ),
});

export interface GasolinerasDeps {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Para el aviso «si baja de X» (rutinas). Sin esto, el aviso no se ofrece. */
  store?: Pick<Store, 'saveRoutine' | 'deleteRoutine' | 'getRoutine'>;
  scopeOf?: () => string;
  sync?: () => void;
  /** «Solo si cambia» para la rutina del aviso, para que no escriba lo mismo dos veces. */
  delivery?: {
    set(scope: string, name: string, setting: DeliverySetting): void;
    commit(scope: string, name: string, hash: string): void;
  };
}

/** «1,459» → 1.459; vacío o raro → null. */
export function parsePrecio(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const n = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'a', 'en']);
/** «CALLE CARMEN, 24» → «Calle Carmen, 24». */
export function titulo(text: string): string {
  return text
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/^(\p{L})/u, (c) => c.toUpperCase())))
    .join('')
    .trim();
}

/** Las gasolineras de la respuesta del Ministerio con precio para ese combustible, de más barata a más cara. */
export function parseGasolineras(body: unknown, c: Combustible): Gasolinera[] {
  const list = (body as { ListaEESSPrecio?: unknown })?.ListaEESSPrecio;
  if (!Array.isArray(list)) return [];
  const out: Gasolinera[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const precio = parsePrecio(e?.[COMBUSTIBLES[c].field]);
    if (precio === null) continue;
    const s = (k: string): string => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
    out.push({
      marca: titulo(s('Rótulo')) || 'Gasolinera',
      direccion: titulo(s('Dirección')),
      localidad: titulo(s('Localidad')),
      horario: s('Horario'),
      precio,
    });
  }
  return out.sort((a, b) => a.precio - b.precio);
}

const euros = (n: number): string => `${n.toFixed(3).replace('.', ',')} €`;

function linea(g: Gasolinera, i: number): string {
  const h = /24H/i.test(g.horario) ? ' (24 h)' : '';
  return `${i + 1}. ${euros(g.precio)} — ${g.marca}, ${g.direccion}${h}`;
}

/** «01/11/2026 8:36:16» → «8:36». */
function horaDe(fecha: unknown): string | null {
  const m = typeof fecha === 'string' ? fecha.match(/\s(\d{1,2}:\d{2})/) : null;
  return m?.[1] ?? null;
}

/** El texto del aviso cuando no hay ninguna por debajo: fijo, para que «solo si cambia» lo calle. */
export function sinNovedad(c: Combustible, umbral: number, sitio: string): string {
  return `Ninguna gasolinera de ${sitio} tiene el ${COMBUSTIBLES[c].label.toLowerCase()} a ${euros(umbral)} o menos.`;
}

const DOWN =
  'No pude consultar los precios de las gasolineras ahora: el servicio del Ministerio no responde. Prueba en un rato.';

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();

export function createGasolinerasTool(deps: GasolinerasDeps = {}): AgentTool<typeof Params> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; body: unknown }>();
  let municipios: { at: number; list: { id: string; name: string }[] } | null = null;

  const getJson = async (url: string): Promise<unknown> => {
    const res = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };

  /** PA_GASOLINERAS_MUNICIPIO: nombre («Oviedo») o ID del Ministerio; vacío = Gijón. */
  const municipio = async (): Promise<{ id: string; name: string } | null> => {
    const raw = (deps.env ?? process.env).PA_GASOLINERAS_MUNICIPIO?.trim() ?? '';
    if (!raw || fold(raw) === 'gijon') return GIJON;
    if (/^\d+$/.test(raw)) return { id: raw, name: `el municipio ${raw}` };
    if (!municipios || now().getTime() - municipios.at > MUNICIPIOS_CACHE_MS) {
      const body = await getJson(`${API}/Listados/Municipios/`);
      const list = Array.isArray(body)
        ? (body as Record<string, unknown>[])
            .filter((m) => typeof m?.IDMunicipio === 'string' && typeof m?.Municipio === 'string')
            .map((m) => ({ id: m.IDMunicipio as string, name: m.Municipio as string }))
        : [];
      municipios = { at: now().getTime(), list };
    }
    return municipios.list.find((m) => fold(m.name) === fold(raw)) ?? null;
  };

  const estaciones = async (id: string): Promise<unknown> => {
    const hit = cache.get(id);
    if (hit && now().getTime() - hit.at < CACHE_MS) return hit.body;
    const body = await getJson(
      `${API}/EstacionesTerrestres/FiltroMunicipio/${encodeURIComponent(id)}`,
    );
    cache.set(id, { at: now().getTime(), body });
    return body;
  };

  const defaultFuel = (): Combustible | null => {
    const raw = fold((deps.env ?? process.env).PA_CARBURANTE ?? '').replace(/[\s-]+/g, '_');
    const alias: Record<string, Combustible> = {
      gasoleo: 'diesel',
      gasoleo_a: 'diesel',
      gasolina: 'gasolina95',
      gasolina_95: 'gasolina95',
      gasolina_98: 'gasolina98',
    };
    const c = alias[raw] ?? raw;
    return isCombustible(c) ? c : null;
  };

  /** Enciende o apaga el aviso «si baja de X». Devuelve la frase para el chat. */
  const aviso = (
    mode: 'activar' | 'desactivar',
    c: Combustible | null,
    umbral: number | undefined,
    sitio: string,
  ): string => {
    const { store, scopeOf } = deps;
    if (!store || !scopeOf) return 'El aviso de gasolineras no está disponible aquí.';
    const scope = scopeOf();
    if (mode === 'desactivar') {
      const fuels = c ? [c] : (Object.keys(COMBUSTIBLES) as Combustible[]);
      const gone = fuels.filter((f) => store.getRoutine(scope, avisoRoutineName(f)));
      if (gone.length === 0) return 'No tenías puesto ningún aviso de gasolineras.';
      for (const f of gone) store.deleteRoutine(scope, avisoRoutineName(f));
      deps.sync?.();
      return `Hecho: quito el aviso de ${gone.map((f) => COMBUSTIBLES[f].label.toLowerCase()).join(' y ')}.`;
    }
    if (!c) return '¿Para qué combustible pongo el aviso: diésel o gasolina 95?';
    const label = COMBUSTIBLES[c].label.toLowerCase();
    if (umbral === undefined || !(umbral > 0.3 && umbral < 5))
      return `¿Por debajo de qué precio te aviso del ${label}? Dímelo en euros por litro, por ejemplo 1,40.`;
    const name = avisoRoutineName(c);
    store.saveRoutine({
      scope,
      name,
      kind: 'schedule',
      schedule: AVISO_SCHEDULE,
      prompt: `Usa la herramienta gasolineras con combustible «${c}» y umbral ${umbral} y responde solo con el texto que te devuelva, tal cual, sin añadir nada.`,
      enabled: true,
    });
    // «Solo si cambia», y el «ninguna por debajo» ya cuenta como dicho: la rutina solo
    // escribe cuando alguna baja (o cambia la lista de las que están por debajo).
    deps.delivery?.set(scope, name, { target: 'chat', soloSiCambia: true });
    deps.delivery?.commit(scope, name, outputHash(sinNovedad(c, umbral, sitio)));
    deps.sync?.();
    return `Hecho: miro a las 9:00 y a las 19:00 y te aviso cuando alguna gasolinera de ${sitio} tenga el ${label} a ${euros(umbral)} o menos. Para quitarlo, dime «quita el aviso de la gasolina».`;
  };

  return {
    name: 'gasolineras',
    label: 'Gasolineras más baratas',
    description:
      'Cheapest petrol stations in the owner’s town (PA_GASOLINERAS_MUNICIPIO, default Gijón) from the Spanish Ministry’s official prices (updated every 30 min, no key). Use for «¿dónde echo gasolina más barata?», «¿a cuánto está el diésel?», «¿hay alguna por debajo de 1,40?». Read-only. aviso=activar (with umbral) / desactivar only when the owner asks for an alert when the price drops.',
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = async (): Promise<string> => {
        const chosen = args.combustible ?? defaultFuel();
        let place: { id: string; name: string } | null;
        try {
          place = await municipio();
        } catch (err) {
          log.warn('gasolineras: fallo al leer municipios', { err: String(err) });
          return DOWN;
        }
        if (!place)
          return 'No encuentro el municipio de PA_GASOLINERAS_MUNICIPIO. Escríbelo como sale en el mapa, por ejemplo «Oviedo».';
        if (args.aviso) return aviso(args.aviso, chosen, args.umbral, place.name);
        let body: unknown;
        try {
          body = await estaciones(place.id);
        } catch (err) {
          log.warn('gasolineras: fallo al consultar', { err: String(err) });
          return DOWN;
        }
        const hora = horaDe((body as { Fecha?: unknown })?.Fecha);
        const n = args.cuantas ?? 5;
        const fuels: Combustible[] = chosen ? [chosen] : ['diesel', 'gasolina95'];

        const umbral = args.umbral;
        if (umbral !== undefined) {
          const c = fuels[0] as Combustible;
          const all = parseGasolineras(body, c);
          if (all.length === 0)
            return `No hay precios de ${COMBUSTIBLES[c].label.toLowerCase()} en ${place.name} ahora mismo.`;
          const below = all.filter((g) => g.precio <= umbral + 1e-9);
          if (below.length === 0) return sinNovedad(c, umbral, place.name);
          return `${COMBUSTIBLES[c].label} a ${euros(umbral)} o menos en ${place.name}:\n${below.slice(0, n).map(linea).join('\n')}`;
        }

        const blocks: string[] = [];
        for (const c of fuels) {
          const list = parseGasolineras(body, c);
          if (list.length === 0) continue;
          blocks.push(`${COMBUSTIBLES[c].label}:\n${list.slice(0, n).map(linea).join('\n')}`);
        }
        if (blocks.length === 0)
          return `No hay precios para ese combustible en ${place.name} ahora mismo.`;
        return `Gasolineras más baratas en ${place.name}${hora ? ` (precios de las ${hora})` : ''}:\n${blocks.join('\n\n')}`;
      };
      return { content: [{ type: 'text', text: await text() }], details: {} };
    },
  };
}
