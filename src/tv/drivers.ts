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
