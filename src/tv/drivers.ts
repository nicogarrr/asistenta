/**
 * Interfaz común para teles que no son LG webOS (Roku, Samsung...).
 *
 * La LG sigue por su camino de siempre (SSAP + Glasshouse en plugins/tv.ts):
 * nada de esto la toca. Cada marca implementa lo que su protocolo abierto
 * permite; lo que no, se dice claro sin tocar la tele.
 */

import type { TvIntent } from './natural.js';

export type TvDriverKey = 'BACK' | 'HOME' | 'ENTER' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'EXIT';
export type TvDriverMedia = 'play' | 'pause' | 'stop' | 'rewind' | 'fastForward';

export interface TvDriver {
  /** Marca legible («Roku», «Samsung»). */
  brand: string;
  power(on: boolean): Promise<void>;
  /** Pasos de volumen: positivos suben, negativos bajan. */
  volumeStep(steps: number): Promise<void>;
  /** Volumen exacto, si el protocolo lo permite. */
  setVolume?(level: number): Promise<void>;
  /** Silencio. `toggles: true` si la marca solo sabe alternar. */
  mute(on: boolean): Promise<{ toggles?: boolean } | undefined>;
  key(name: TvDriverKey): Promise<void>;
  /** appId en el idioma de las LG (APP_ALIASES: netflix, youtube.leanback.v4...). */
  launch?(appId: string): Promise<void>;
  media?(command: TvDriverMedia): Promise<void>;
  /** Apps instaladas de verdad (Roku /query/apps, Samsung ed.installedApp.get). */
  apps?(): Promise<Array<{ id: string; title: string }>>;
  /** Buscar `query` (dentro de la app `appId`, en el idioma de las LG, si se da). */
  search?(query: string, appId?: string): Promise<void>;
}

/** Órdenes de «poner algo» que encienden antes una tele apagada del todo (como la LG, #1936). */
const WAKES_FOR = new Set<TvIntent['action']>(['launch', 'search']);
/** Lo que tarda como mucho una tele en aceptar órdenes tras encenderla por red. */
export const DRIVER_BOOT_MS = 20_000;
const DRIVER_RETRY_MS = 2_000;

/** El driver no llegó a conectar (no salió ninguna orden): seguro encender y repetir. */
function isDriverUnreachable(err: unknown): boolean {
  return err instanceof Error && (err as Error & { unreachable?: unknown }).unreachable === true;
}

export interface WakeOptions {
  bootMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Como runIntentOnDriver, pero «pon en YouTube X» o «abre Netflix» con la tele
 * apagada del todo la encienden por red y repiten la orden hasta que la tele
 * contesta (como la LG desde #1936). Antes la Samsung contestaba «No llego a
 * la Samsung» y había que pedir «enciende la tele» y repetir la orden.
 * Solo si no salió nada (no conectó): una orden que llegó nunca se repite.
 */
export async function runIntentWaking(
  driver: TvDriver,
  intent: TvIntent,
  opts: WakeOptions = {},
): Promise<string> {
  try {
    return await runIntentOnDriver(driver, intent);
  } catch (err) {
    if (!WAKES_FOR.has(intent.action) || !isDriverUnreachable(err)) throw err;
    try {
      await driver.power(true);
    } catch {
      // Sin MAC o sin Wake-on-LAN: el error de siempre («no llego»).
      throw err;
    }
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.bootMs ?? DRIVER_BOOT_MS);
    for (;;) {
      await sleep(opts.retryMs ?? DRIVER_RETRY_MS);
      try {
        const said = await runIntentOnDriver(driver, intent);
        return `La ${driver.brand} estaba apagada del todo: la he encendido por red (Wake-on-LAN) antes. ${said}`;
      } catch (again) {
        if (!isDriverUnreachable(again) || now() >= deadline) {
          if (isDriverUnreachable(again)) {
            throw new Error(
              `He encendido la ${driver.brand} por red, pero no contesta tras ${Math.round((opts.bootMs ?? DRIVER_BOOT_MS) / 1000)} s; no he podido ${intent.action === 'search' ? 'buscar' : 'abrir la app'}. Repítelo en un momento.`,
            );
          }
          throw again;
        }
      }
    }
  }
}

/** Tope de pasos seguidos: «sube 50» no son 50 pulsaciones a ciegas. */
export const MAX_DRIVER_STEPS = 20;

/** Ejecuta una orden ya entendida en una tele no-LG y devuelve la frase para el dueño. */
export async function runIntentOnDriver(driver: TvDriver, intent: TvIntent): Promise<string> {
  const no = (what: string) =>
    new Error(
      `La ${driver.brand} no deja ${what} desde Asistenta (su protocolo abierto no lo tiene); no he tocado la tele.`,
    );
  switch (intent.action) {
    case 'power':
      await driver.power(intent.on);
      return intent.on ? `${driver.brand}: encendido enviado.` : `${driver.brand}: apagada.`;
    case 'volume':
      if (!driver.setVolume)
        throw no('poner el volumen exacto; dime «sube el volumen» o «baja el volumen»');
      await driver.setVolume(Math.max(0, Math.min(100, Math.round(intent.level))));
      return `${driver.brand}: volumen a ${Math.round(intent.level)}.`;
    case 'volumeStep': {
      const steps = Math.max(
        -MAX_DRIVER_STEPS,
        Math.min(MAX_DRIVER_STEPS, Math.trunc(intent.steps)),
      );
      if (steps === 0) return `${driver.brand}: volumen sin cambios.`;
      await driver.volumeStep(steps);
      return `${driver.brand}: volumen ${steps > 0 ? 'subido' : 'bajado'} ${Math.abs(steps)}.`;
    }
    case 'mute': {
      const r = await driver.mute(intent.on);
      return r?.toggles
        ? `${driver.brand}: silencio alternado (esta tele solo sabe alternarlo).`
        : `${driver.brand}: ${intent.on ? 'en silencio' : 'con sonido'}.`;
    }
    case 'key':
      await driver.key(intent.name);
      return `${driver.brand}: tecla ${intent.name} pulsada.`;
    case 'launch':
      if (!driver.launch) throw no('abrir apps');
      await driver.launch(intent.appId);
      return `${driver.brand}: abriendo ${intent.appId}.`;
    case 'media':
      if (!driver.media) throw no('pausar o reproducir');
      await driver.media(intent.command);
      return `${driver.brand}: ${intent.command} enviado.`;
    case 'search':
      if (!driver.search) throw no('buscar dentro de las apps');
      await driver.search(intent.text, intent.appId);
      return `${driver.brand}: buscando «${intent.text}».`;
    case 'volumeHalf':
      throw no('bajar el volumen a la mitad (no dice el volumen que tiene)');
    case 'channel':
      throw no('cambiar de canal');
    case 'input':
      throw no('cambiar de entrada');
    case 'status':
      throw no('leer qué está viendo');
    default:
      throw no(`hacer «${intent.action}»`);
  }
}
