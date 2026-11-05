import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from './core/lazy-schema.js';
import { setAsideCorrupt, writeFileReplacing } from './fs-tmp.js';
import { aSitio, deSitio, esSitioPropio, SITIO_POSICION_MAX_MS, sitioKey } from './sitios.js';

/**
 * Avisos al llegar a un sitio: «cuando llegue a casa recuérdame sacar la basura».
 *
 * Antes Asistenta leía una ubicación compartida, pero de una ubicación en directo decía
 * «solo veo el punto de partida» e ignoraba las actualizaciones que Telegram manda
 * mientras Nico se mueve. Ahora esas actualizaciones se comparan con los avisos
 * pendientes del chat (`<estado>/avisos-llegada.json`) y, al entrar en el radio del
 * sitio, el aviso salta una vez y se borra.
 *
 * - «casa» es el sitio de PA_BRIEFING_LAT/LON (el del tiempo y el resumen de la mañana);
 *   otros sitios, por nombre de ciudad o pueblo (buscador gratuito de Open-Meteo).
 * - Un aviso solo salta después de haber visto a Nico FUERA del sitio: si lo pide
 *   estando ya en casa, no salta al momento, sino al volver.
 * - Hace falta que Nico comparta su ubicación en directo con el bot (Telegram la deja
 *   hasta 8 h, o «hasta que la desactive»): el aviso al crearlo lo explica.
 * - También al SALIR: «cuando salga de casa recuérdame las llaves» salta al salir del
 *   radio después de haberle visto dentro.
 * - Sitios guardados por nombre: con la última ubicación que mandó, «guarda esto como
 *   el gimnasio»; luego «cuando llegue al gimnasio…» usa ese punto (src/sitios.ts).
 */

export interface LlegadaAviso {
  id: number;
  chatId: string;
  text: string;
  place: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  /** Ya se le ha visto fuera del radio (al llegar) o dentro (al salir). */
  armed: boolean;
  createdAt: number;
  /** «salir»: salta al salir del sitio. Sin campo (avisos de antes) = al llegar. */
  modo?: 'llegar' | 'salir';
}

export interface SitioGuardado {
  chatId: string;
  /** Nombre como lo dijo Nico («el gimnasio»). */
  name: string;
  latitude: number;
  longitude: number;
}

interface LlegadaFile {
  avisos: LlegadaAviso[];
  nextId: number;
  sitios?: SitioGuardado[];
  /** Última posición recibida por chat, para «guarda esto como…». */
  ultima?: Record<string, { latitude: number; longitude: number; at: number }>;
}

const MAX_SITIOS = 50;

const MAX_AVISOS = 50;
/** Radio por defecto: casa (calle) y una ciudad o pueblo. */
export const RADIO_CASA_M = 200;
export const RADIO_CIUDAD_M = 3000;

/** Distancia en metros entre dos puntos (haversine). */
export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class LlegadaStore {
  readonly #path: string;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  #read(): LlegadaFile {
    if (!existsSync(this.#path)) return { avisos: [], nextId: 1 };
    try {
      const data = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<LlegadaFile>;
      const avisos = Array.isArray(data.avisos)
        ? data.avisos.filter(
            (a): a is LlegadaAviso =>
              Boolean(a) &&
              typeof a.id === 'number' &&
              typeof a.text === 'string' &&
              Number.isFinite(a.latitude) &&
              Number.isFinite(a.longitude),
          )
        : [];
      const maxId = avisos.reduce((m, a) => Math.max(m, a.id), 0);
      const sitios = Array.isArray(data.sitios)
        ? data.sitios.filter(
            (x): x is SitioGuardado =>
              Boolean(x) &&
              typeof x.name === 'string' &&
              typeof x.chatId === 'string' &&
              Number.isFinite(x.latitude) &&
              Number.isFinite(x.longitude),
          )
        : [];
      const ultima =
        data.ultima && typeof data.ultima === 'object' && !Array.isArray(data.ultima)
          ? data.ultima
          : {};
      return { avisos, nextId: Math.max(Number(data.nextId) || 1, maxId + 1), sitios, ultima };
    } catch {
      setAsideCorrupt(this.#path);
      return { avisos: [], nextId: 1 };
    }
  }

  #write(data: LlegadaFile): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileReplacing(this.#path, `${JSON.stringify(data, null, 2)}\n`);
  }

  list(chatId: string): LlegadaAviso[] {
    return this.#read().avisos.filter((a) => a.chatId === chatId);
  }

  add(a: Omit<LlegadaAviso, 'id' | 'armed' | 'createdAt'>): LlegadaAviso | null {
    const data = this.#read();
    if (data.avisos.length >= MAX_AVISOS) return null;
    const aviso: LlegadaAviso = { ...a, id: data.nextId++, armed: false, createdAt: this.#now() };
    data.avisos.push(aviso);
    this.#write(data);
    return aviso;
  }

  remove(chatId: string, id: number): boolean {
    const data = this.#read();
    const before = data.avisos.length;
    data.avisos = data.avisos.filter((a) => !(a.chatId === chatId && a.id === id));
    if (data.avisos.length === before) return false;
    this.#write(data);
    return true;
  }

  /** Sitios guardados de este chat («el gimnasio», «la oficina»). */
  sitios(chatId: string): SitioGuardado[] {
    return (this.#read().sitios ?? []).filter((x) => x.chatId === chatId);
  }

  /** El sitio guardado con ese nombre (sin artículo, tildes ni mayúsculas), o null. */
  sitio(chatId: string, name: string): SitioGuardado | null {
    const key = sitioKey(name);
    if (!key) return null;
    return this.sitios(chatId).find((x) => sitioKey(x.name) === key) ?? null;
  }

  /** La última posición de este chat si es de hace menos de `maxAgeMs`. */
  ultima(chatId: string, maxAgeMs: number): { latitude: number; longitude: number } | null {
    const u = this.#read().ultima?.[chatId];
    if (!u || !Number.isFinite(u.latitude) || !Number.isFinite(u.longitude)) return null;
    if (!(this.#now() - Number(u.at) <= maxAgeMs)) return null;
    return { latitude: u.latitude, longitude: u.longitude };
  }

  /** Guarda (o mueve) un sitio con nombre. false si ya hay demasiados. */
  guardarSitio(chatId: string, name: string, at: { latitude: number; longitude: number }): boolean {
    const data = this.#read();
    const key = sitioKey(name);
    const sitios = (data.sitios ?? []).filter(
      (x) => !(x.chatId === chatId && sitioKey(x.name) === key),
    );
    if (sitios.length >= MAX_SITIOS) return false;
    sitios.push({ chatId, name: name.trim(), latitude: at.latitude, longitude: at.longitude });
    data.sitios = sitios;
    this.#write(data);
    return true;
  }

  borrarSitio(chatId: string, name: string): boolean {
    const data = this.#read();
    const key = sitioKey(name);
    const before = (data.sitios ?? []).length;
    data.sitios = (data.sitios ?? []).filter(
      (x) => !(x.chatId === chatId && sitioKey(x.name) === key),
    );
    if (data.sitios.length === before) return false;
    this.#write(data);
    return true;
  }

  /**
   * Un punto compartido (sin directo, o un sitio del mapa): puede no ser donde está Nico,
   * así que solo se apunta como «última» para «guarda esto como…»; no mueve los avisos.
   */
  puntoCompartido(chatId: string, at: { latitude: number; longitude: number }): void {
    const data = this.#read();
    data.ultima = {
      ...(data.ultima ?? {}),
      [chatId]: { latitude: at.latitude, longitude: at.longitude, at: this.#now() },
    };
    this.#write(data);
  }

  /**
   * Una posición nueva de Nico en este chat: la apunta como «última» (para «guarda
   * esto como…»), arma los avisos y devuelve (y borra) los que acaban de cumplirse:
   * al entrar en el sitio (llegar) o al salir de él (salir).
   */
  position(chatId: string, at: { latitude: number; longitude: number }): LlegadaAviso[] {
    const data = this.#read();
    const fired: LlegadaAviso[] = [];
    data.ultima = {
      ...(data.ultima ?? {}),
      [chatId]: { latitude: at.latitude, longitude: at.longitude, at: this.#now() },
    };
    data.avisos = data.avisos.filter((a) => {
      if (a.chatId !== chatId) return true;
      const d = distanceM(a, at);
      if (a.modo === 'salir') {
        if (d <= a.radiusM) {
          a.armed = true;
          return true;
        }
        if (a.armed && d > a.radiusM * 1.2) {
          fired.push(a);
          return false;
        }
        return true;
      }
      if (d <= a.radiusM) {
        if (a.armed) {
          fired.push(a);
          return false;
        }
        return true;
      }
      if (!a.armed && d > a.radiusM * 1.2) a.armed = true;
      return true;
    });
    this.#write(data);
    return fired;
  }
}

/** El mensaje cuando salta. */
export function llegadaFiredText(a: LlegadaAviso): string {
  return a.modo === 'salir'
    ? `🚪 Sales ${deSitio(a.place)}: ${a.text}`
    : `📍 Has llegado ${aSitio(a.place)}: ${a.text}`;
}

export const LLEGADA_COMO =
  'Para que funcione, compárteme tu ubicación en directo: 📎 → Ubicación → «Compartir mi ubicación en tiempo real» (mejor «hasta que la desactive»).';

/**
 * «cuando llegue a casa recuérdame sacar la basura», «recuérdame comprar pan cuando
 * llegue a Oviedo», «avísame de llamar a mamá al llegar a casa», «cuando llegue al
 * gimnasio…» (sitio guardado) y al salir: «cuando salga de casa recuérdame las llaves».
 * null si no es eso.
 */
export function llegadaIntent(
  text: string | undefined,
): { place: string; text: string; modo?: 'salir' } | null {
  if (!text) return null;
  const t = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    // «al gimnasio» / «del trabajo» → «a el gimnasio» / «de el trabajo»: el sitio
    // guardado se llama «el gimnasio».
    .replace(/\b(llegue|llegar|vuelva|volver)\s+al\s+/giu, '$1 a el ')
    .replace(/\b(salga|salir|vaya|irme|marche|marcharme)\s+del\s+/giu, '$1 de el ');
  if (t.length > 300) return null;
  const LLEGUE = String.raw`(?:cuando|en cuanto|nada m[aá]s)\s+(?:llegue|est[eé]|vuelva)\s+(?:a|en)\s+|al\s+(?:llegar|volver)\s+a\s+`;
  const SALGA = String.raw`(?:cuando|en cuanto|nada m[aá]s)\s+(?:salga|me vaya|me marche)\s+de\s+|al\s+(?:salir|irme|marcharme)\s+de\s+`;
  const RECUERDA = String.raw`(?:recu[eé]rdame|av[ií]same(?:\s+de)?|dime)(?:\s+que)?`;
  const placeRe = String.raw`(casa|[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñü.-]*(?:\s+(?:de\s+)?[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñü.-]*){0,2})`;
  for (const [cue, modo] of [
    [LLEGUE, undefined],
    [SALGA, 'salir'],
  ] as const) {
    const extra = modo ? { modo } : {};
    const first = new RegExp(`^(?:${cue})${placeRe}\\s*,?\\s+${RECUERDA}\\s+(.+)$`, 'iu').exec(t);
    if (first?.[1] && first[2]) return { place: first[1], text: first[2].trim(), ...extra };
    const last = new RegExp(`^${RECUERDA}\\s+(.+?)\\s+(?:${cue})${placeRe}$`, 'iu').exec(t);
    if (last?.[1] && last[2]) return { place: last[2], text: last[1].trim(), ...extra };
  }
  return null;
}

export interface LlegadaDeps {
  store: LlegadaStore;
  /** Casa: PA_BRIEFING_LAT/LON. */
  home: () => { latitude: number; longitude: number } | null;
  geocode: (
    place: string,
  ) => Promise<{ latitude: number; longitude: number; label?: string } | null>;
}

const comoGuardar = (place: string) =>
  `No tengo guardado «${place}». Estando allí, mándame la ubicación (📎 → Ubicación) y dime «guarda esto como ${place}».`;

/** Crea el aviso (al llegar o al salir) y devuelve la respuesta para Nico. Nunca lanza. */
export async function crearLlegada(
  deps: LlegadaDeps,
  chatId: string,
  place: string,
  text: string,
  modo: 'llegar' | 'salir' = 'llegar',
): Promise<string> {
  const name = place.trim();
  const saved = deps.store.sitio(chatId, name);
  const isHome = !saved && /^casa$/i.test(name);
  let where: { latitude: number; longitude: number; label?: string } | null = saved
    ? { latitude: saved.latitude, longitude: saved.longitude, label: saved.name }
    : null;
  if (!where) {
    if (!isHome && esSitioPropio(name)) return comoGuardar(name);
    try {
      where = isHome ? deps.home() : await deps.geocode(name);
    } catch {
      return `No he podido buscar «${place}» ahora mismo; prueba otra vez en un rato.`;
    }
  }
  if (!where)
    return isHome
      ? 'No sé dónde está tu casa: pon PA_BRIEFING_LAT y PA_BRIEFING_LON en el .env (las mismas del tiempo), o mándame la ubicación estando en casa y dime «guarda esto como casa».'
      : `No encuentro «${place}». Dime una ciudad o un pueblo, o guárdalo: mándame la ubicación estando allí y dime «guarda esto como ${name}».`;
  const label = isHome ? 'casa' : where.label || name;
  const aviso = deps.store.add({
    chatId,
    text: text.slice(0, 300),
    place: label,
    latitude: where.latitude,
    longitude: where.longitude,
    radiusM: isHome || saved ? RADIO_CASA_M : RADIO_CIUDAD_M,
    ...(modo === 'salir' ? { modo } : {}),
  });
  if (!aviso) return 'Ya tienes demasiados avisos de llegada; borra alguno antes.';
  return modo === 'salir'
    ? `🚪 Hecho: cuando salgas ${deSitio(label)} te recuerdo «${aviso.text}». ${LLEGADA_COMO}`
    : `📍 Hecho: cuando llegues ${aSitio(label)} te recuerdo «${aviso.text}». ${LLEGADA_COMO}`;
}

/**
 * «guarda esto como el gimnasio»: guarda la última ubicación que llegó a este chat.
 * null si no hay una reciente y la frase no hablaba de ubicación (solo «esto»): puede
 * ser otra cosa y la decide el modelo.
 */
export function guardarSitio(
  store: LlegadaStore,
  chatId: string,
  intent: { name: string; explicito: boolean },
): string | null {
  const at = store.ultima(chatId, SITIO_POSICION_MAX_MS);
  if (!at) {
    if (!intent.explicito) return null;
    return `Mándame primero la ubicación (📎 → Ubicación) y luego dime «guarda esto como ${intent.name}».`;
  }
  if (!store.guardarSitio(chatId, intent.name, at))
    return 'Ya tienes demasiados sitios guardados; borra alguno antes.';
  return `📍 Guardado «${intent.name}». Ya puedes decirme «cuando llegue ${aSitio(intent.name)} recuérdame…» o «cuando salga ${deSitio(intent.name)}…».`;
}

const Params = lazySchema(() =>
  Type.Object({
    accion: Type.Union(
      [
        Type.Literal('crear'),
        Type.Literal('ver'),
        Type.Literal('borrar'),
        Type.Literal('guardar_sitio'),
        Type.Literal('borrar_sitio'),
      ],
      {
        description:
          'crear | ver | borrar | guardar_sitio (la última ubicación que mandó, con el nombre de «lugar») | borrar_sitio',
      },
    ),
    lugar: Type.Optional(
      Type.String({
        maxLength: 80,
        description: '«casa», un sitio guardado («el gimnasio») o una ciudad o pueblo.',
      }),
    ),
    texto: Type.Optional(Type.String({ maxLength: 300, description: 'Qué recordarle.' })),
    modo: Type.Optional(
      Type.Union([Type.Literal('llegar'), Type.Literal('salir')], {
        description: 'llegar (por defecto) o salir: avisar al salir del sitio.',
      }),
    ),
    id: Type.Optional(Type.Number({ description: 'Número del aviso a borrar (de «ver»).' })),
  }),
);

/** Herramienta del modelo para las formas que el atajo sin modelo no entiende. */
export function createLlegadaTool(
  deps: LlegadaDeps,
  chatId: () => string,
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'aviso_llegada',
    label: 'Aviso al llegar',
    description:
      "Location-based reminders: «cuando llegue a casa recuérdame X», «al llegar a Oviedo avísame de Y», «cuando salga de casa recuérdame Z» (modo salir). Place is «casa» (home), a saved place («el gimnasio») or a city/town name. Fires once when the owner's Telegram live location enters (or leaves) the place. guardar_sitio saves the last location the owner sent under a name («guarda esto como el gimnasio»). Also list (ver) and delete (borrar, borrar_sitio). Not for time-based reminders.",
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const chat = chatId();
      let text: string;
      if (args.accion === 'crear') {
        text =
          args.lugar?.trim() && args.texto?.trim()
            ? await crearLlegada(deps, chat, args.lugar, args.texto, args.modo ?? 'llegar')
            : 'Dime el sitio («casa», un sitio guardado o una ciudad) y qué te recuerdo.';
      } else if (args.accion === 'borrar') {
        text =
          typeof args.id === 'number' && deps.store.remove(chat, args.id)
            ? 'Aviso de llegada borrado.'
            : 'No tengo ese aviso de llegada.';
      } else if (args.accion === 'guardar_sitio') {
        text = args.lugar?.trim()
          ? (guardarSitio(deps.store, chat, { name: args.lugar.trim(), explicito: true }) ?? '')
          : 'Dime con qué nombre lo guardo.';
      } else if (args.accion === 'borrar_sitio') {
        text =
          args.lugar?.trim() && deps.store.borrarSitio(chat, args.lugar)
            ? `Sitio «${args.lugar.trim()}» borrado.`
            : 'No tengo ese sitio guardado.';
      } else {
        const list = deps.store.list(chat);
        const sitios = deps.store.sitios(chat);
        const lines = list.map((a) =>
          a.modo === 'salir'
            ? `${a.id}. Al salir ${deSitio(a.place)}: ${a.text}`
            : `${a.id}. Al llegar ${aSitio(a.place)}: ${a.text}`,
        );
        if (!lines.length) lines.push('No tienes avisos de llegada.');
        if (sitios.length) lines.push(`Sitios guardados: ${sitios.map((x) => x.name).join(', ')}`);
        text = lines.join('\n');
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}
