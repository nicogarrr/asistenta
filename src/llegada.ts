import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from './core/lazy-schema.js';
import { setAsideCorrupt, writeFileReplacing } from './fs-tmp.js';

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
 */

export interface LlegadaAviso {
  id: number;
  chatId: string;
  text: string;
  place: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  /** Ya se le ha visto fuera del radio: entrar ahora sí es «llegar». */
  armed: boolean;
  createdAt: number;
}

interface LlegadaFile {
  avisos: LlegadaAviso[];
  nextId: number;
}

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
      return { avisos, nextId: Math.max(Number(data.nextId) || 1, maxId + 1) };
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

  /**
   * Una posición nueva de Nico en este chat: arma los avisos de los sitios de los que
   * está fuera y devuelve (y borra) los que acaban de cumplirse al entrar.
   */
  position(chatId: string, at: { latitude: number; longitude: number }): LlegadaAviso[] {
    const data = this.#read();
    const fired: LlegadaAviso[] = [];
    let changed = false;
    data.avisos = data.avisos.filter((a) => {
      if (a.chatId !== chatId) return true;
      const d = distanceM(a, at);
      if (d <= a.radiusM) {
        if (a.armed) {
          fired.push(a);
          changed = true;
          return false;
        }
        return true;
      }
      if (!a.armed && d > a.radiusM * 1.2) {
        a.armed = true;
        changed = true;
      }
      return true;
    });
    if (changed) this.#write(data);
    return fired;
  }
}

/** El mensaje cuando salta. */
export function llegadaFiredText(a: LlegadaAviso): string {
  return `📍 Has llegado a ${a.place}: ${a.text}`;
}

export const LLEGADA_COMO =
  'Para que funcione, compárteme tu ubicación en directo: 📎 → Ubicación → «Compartir mi ubicación en tiempo real» (mejor «hasta que la desactive»).';

/**
 * «cuando llegue a casa recuérdame sacar la basura», «recuérdame comprar pan cuando
 * llegue a Oviedo», «avísame de llamar a mamá al llegar a casa». null si no es eso.
 */
export function llegadaIntent(text: string | undefined): { place: string; text: string } | null {
  if (!text) return null;
  const t = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
  if (t.length > 300) return null;
  const LLEGUE = String.raw`(?:cuando|en cuanto|nada m[aá]s)\s+(?:llegue|est[eé]|vuelva)\s+(?:a|en)\s+|al\s+llegar\s+a\s+`;
  const RECUERDA = String.raw`(?:recu[eé]rdame|av[ií]same(?:\s+de)?|dime)(?:\s+que)?`;
  const placeRe = String.raw`(casa|[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñü.-]*(?:\s+(?:de\s+)?[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñü.-]*){0,2})`;
  const first = new RegExp(`^(?:${LLEGUE})${placeRe}\\s*,?\\s+${RECUERDA}\\s+(.+)$`, 'iu').exec(t);
  if (first?.[1] && first[2]) return { place: first[1], text: first[2].trim() };
  const last = new RegExp(`^${RECUERDA}\\s+(.+?)\\s+(?:${LLEGUE})${placeRe}$`, 'iu').exec(t);
  if (last?.[1] && last[2]) return { place: last[2], text: last[1].trim() };
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

/** Crea el aviso y devuelve la respuesta para Nico. Nunca lanza. */
export async function crearLlegada(
  deps: LlegadaDeps,
  chatId: string,
  place: string,
  text: string,
): Promise<string> {
  const isHome = /^casa$/i.test(place.trim());
  let where: { latitude: number; longitude: number; label?: string } | null = null;
  try {
    where = isHome ? deps.home() : await deps.geocode(place.trim());
  } catch {
    return `No he podido buscar «${place}» ahora mismo; prueba otra vez en un rato.`;
  }
  if (!where)
    return isHome
      ? 'No sé dónde está tu casa: pon PA_BRIEFING_LAT y PA_BRIEFING_LON en el .env (las mismas del tiempo) y vuelve a pedírmelo.'
      : `No encuentro «${place}». Dime una ciudad o un pueblo.`;
  const label = isHome ? 'casa' : where.label || place.trim();
  const aviso = deps.store.add({
    chatId,
    text: text.slice(0, 300),
    place: label,
    latitude: where.latitude,
    longitude: where.longitude,
    radiusM: isHome ? RADIO_CASA_M : RADIO_CIUDAD_M,
  });
  if (!aviso) return 'Ya tienes demasiados avisos de llegada; borra alguno antes.';
  return `📍 Hecho: cuando llegues a ${label} te recuerdo «${aviso.text}». ${LLEGADA_COMO}`;
}

const Params = lazySchema(() =>
  Type.Object({
    accion: Type.Union([Type.Literal('crear'), Type.Literal('ver'), Type.Literal('borrar')], {
      description: 'crear | ver | borrar',
    }),
    lugar: Type.Optional(
      Type.String({ maxLength: 80, description: '«casa» o el nombre de una ciudad o pueblo.' }),
    ),
    texto: Type.Optional(Type.String({ maxLength: 300, description: 'Qué recordarle al llegar.' })),
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
      "Location-based reminders: «cuando llegue a casa recuérdame X», «al llegar a Oviedo avísame de Y». Place is «casa» (home) or a city/town name. Fires once when the owner's Telegram live location enters the place. Also list (ver) and delete (borrar) them. Not for time-based reminders.",
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const chat = chatId();
      let text: string;
      if (args.accion === 'crear') {
        text =
          args.lugar?.trim() && args.texto?.trim()
            ? await crearLlegada(deps, chat, args.lugar, args.texto)
            : 'Dime el sitio («casa» o una ciudad) y qué te recuerdo.';
      } else if (args.accion === 'borrar') {
        text =
          typeof args.id === 'number' && deps.store.remove(chat, args.id)
            ? 'Aviso de llegada borrado.'
            : 'No tengo ese aviso de llegada.';
      } else {
        const list = deps.store.list(chat);
        text = list.length
          ? list.map((a) => `${a.id}. Al llegar a ${a.place}: ${a.text}`).join('\n')
          : 'No tienes avisos de llegada.';
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}
