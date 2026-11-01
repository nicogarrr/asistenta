import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileReplacing } from '../fs-tmp.js';
import {
  claimTeleFirewallWarning,
  TV_FIREWALL_HINT,
  teleFirewallAlreadyWarned,
} from './tv-cast.js';

/**
 * Modo altavoz: con `/altavoz pc` (o `tele`), cada nota de voz que manda el dueño
 * suena sola al llegar, en orden. Es lo más parecido a «llamar al bot» que permite
 * la Bot API de Telegram (los bots no reciben llamadas): notas encadenadas casi en
 * directo. Apagado por defecto, por chat, persistido en el estado.
 */

export type AltavozMode = 'off' | 'pc' | 'tele';

export type AltavozArgs = { kind: 'show' } | { kind: 'set'; mode: AltavozMode } | { kind: 'error' };

export function parseAltavozArgs(args: string): AltavozArgs {
  const a = args
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!¡]+$/g, '')
    .replace(/^(?:por|en)\s+(?:el|la)\s+|^(?:por|en)\s+/, '')
    .trim();
  if (!a || a === 'estado') return { kind: 'show' };
  if (/^(on|si|pc|ordenador|enciende|activa|activar)$/.test(a)) return { kind: 'set', mode: 'pc' };
  if (/^(tele|tv|television)$/.test(a)) return { kind: 'set', mode: 'tele' };
  if (
    /^(off|no|apaga|apagar|apagalo|desactiva|desactivar|para|ninguno|ninguna|ningun sitio|ningun lado)$/.test(
      a,
    )
  ) {
    return { kind: 'set', mode: 'off' };
  }
  return { kind: 'error' };
}

export function altavozStatusText(mode: AltavozMode): string {
  switch (mode) {
    case 'pc':
      return '🔊 Altavoz activado: tus notas de voz sonarán en el PC al llegar. Si quieres quitarlo, dime «apágalo».';
    case 'tele':
      return '📺 Altavoz activado en la tele: tus notas de voz sonarán en la tele al llegar. Si quieres quitarlo, dime «apágalo».';
    default:
      return '🔇 Altavoz apagado. Si quieres que tus notas de voz suenen solas, dime «por el PC» o «por la tele».';
  }
}

/** Respuesta de /stop: conversaciones abortadas y notas del altavoz cortadas. */
export function stopReplyText(threads: number, notes: number): string {
  const parts: string[] = [];
  if (threads) parts.push(`${threads} conversación(es) abortadas y la cola limpia`);
  if (notes) parts.push(`${notes} nota(s) de voz paradas en el altavoz`);
  return parts.length ? `Detenido. ${parts.join('; ')}.` : 'No había nada en curso.';
}

/**
 * «pon el modo altavoz (en la tele)» / «quita el modo altavoz»: lo mismo que /altavoz pc|tele|off,
 * dicho como en un chat. Pide «modo altavoz» para no confundirlo con «pon el altavoz» (sonar algo).
 */
export function altavozWords(text: string): 'pc' | 'tele' | 'off' | null {
  const t = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!]+$/g, '');
  const on =
    /^(?:pon|activa|enciende)\s+(?:el\s+)?modo\s+altavoz(?:\s+(?:en|por)\s+(?:el\s+|la\s+)?(pc|ordenador|tele|tv))?$/.exec(
      t,
    );
  if (on) return on[1] === 'tele' || on[1] === 'tv' ? 'tele' : 'pc';
  if (/^(?:quita|apaga|desactiva)\s+(?:el\s+)?modo\s+altavoz$/.test(t)) return 'off';
  return null;
}

export const ALTAVOZ_USAGE = '¿Por dónde te hablo: por el PC, por la tele, o lo apago?';

export class AltavozStore {
  #file: string;
  #modes: Record<string, AltavozMode>;

  constructor(file: string) {
    this.#file = file;
    this.#modes = {};
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (v === 'pc' || v === 'tele') this.#modes[k] = v;
      }
    } catch {
      // Sin fichero o corrupto: todo apagado, que es lo seguro.
    }
  }

  get(chat: string): AltavozMode {
    return this.#modes[chat] ?? 'off';
  }

  set(chat: string, mode: AltavozMode): void {
    if (mode === 'off') delete this.#modes[chat];
    else this.#modes[chat] = mode;
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileReplacing(this.#file, JSON.stringify(this.#modes, null, 2));
  }
}

export interface AltavozPlayerDeps {
  /** Convierte los bytes recibidos en un fichero reproducible (MP3). */
  toPlayable(bytes: Buffer, mimeType: string): Promise<string>;
  /**
   * Suena un fichero en el PC sin tocar el volumen; se resuelve al acabar. Si `signal`
   * se aborta (/stop), tiene que cortar el sonido y resolverse.
   */
  playOnPc(file: string, signal?: AbortSignal): Promise<void>;
  /** Manda un fichero a la tele (se queda con él). Ausente si la tele está apagada. */
  castToTv?: (file: string) => Promise<{
    ok: boolean;
    message: string;
    hits?: () => number;
    /** Para esa nota en la tele (el cast sabe si la abrió el visor, el navegador o Glasshouse). */
    stop?: () => Promise<unknown>;
    /** Cierra el servidor LAN que sirve el audio a la tele y borra la copia. */
    close?: () => void;
  }>;
  /**
   * Si la tele aceptó la orden pero no ha descargado el fichero en este tiempo, se avisa
   * (una vez por sesión) de que suele ser el firewall de Windows. Por defecto 15 s.
   */
  noFetchMs?: number;
  /**
   * /stop en modo tele: para lo que suena en la tele (ssap media.controls/stop). Solo se
   * usa si esta cola mandó algo a la tele hace poco (`teleStopWindowMs`): una tele que
   * está con Netflix no se toca. Ausente si la tele está apagada.
   */
  stopTv?: () => Promise<unknown>;
  /** Cuánto tiempo tras mandar una nota a la tele /stop todavía la para. Por defecto 2 min. */
  teleStopWindowMs?: number;
  /** Reloj (para pruebas). */
  now?: () => number;
  /** Borra la copia temporal del PC. */
  remove(file: string): void;
  onError?: (err: unknown) => void;
}

/** Notas en cola como máximo: si se acumulan más, las nuevas se descartan (y se avisa). */
export const ALTAVOZ_MAX_QUEUE = 5;

export interface AltavozPlayer {
  /** Encola una nota. Devuelve false si la cola está llena. */
  enqueue(
    mode: Exclude<AltavozMode, 'off'>,
    load: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
    /** Aviso por nota: quien la mandó tiene que saber que no ha sonado. */
    onFail?: (err: unknown) => void,
    /** Chat que la mandó: /stop en ese chat la para. */
    key?: string,
    /** Aviso a quien la mandó cuando la tele la aceptó pero nunca la descargó. */
    onNotice?: (text: string) => void,
  ): boolean;
  /**
   * /stop: descarta las notas en cola de ese chat (o de todos sin `key`) y corta la que
   * suena en el PC. Si ese chat mandó una nota a la tele hace menos de
   * `teleStopWindowMs`, también la para en la tele. Devuelve cuántas notas paró. Las
   * descartadas no avisan de fallo.
   */
  clear(key?: string): number;
  /**
   * Apunta una nota que llegó a la tele por otro camino («reprodúcelo en la tele»), para
   * que /stop en ese chat la pare igual que una de /altavoz tele: solo dentro de
   * `teleStopWindowMs` y con el `stop` del propio cast (si no hay, el genérico).
   */
  noteTele(
    key: string | undefined,
    stop?: () => Promise<unknown>,
    close?: () => void,
  ): TeleCastHandle;
  /** Promesa de la cola actual (para pruebas y para /stop). */
  idle(): Promise<void>;
  pending(): number;
}

/** Lo que devuelve `noteTele`: si /stop ya paró ese cast (para no avisar del firewall). */
export interface TeleCastHandle {
  stopped(): boolean;
}

/**
 * Cola en serie: dos notas seguidas suenan una detrás de otra, nunca a la vez, y un
 * fallo en una no para las siguientes.
 */
export function createAltavozPlayer(deps: AltavozPlayerDeps): AltavozPlayer {
  let chain: Promise<void> = Promise.resolve();
  let waiting = 0;
  /** Notas aún sin terminar, para que /stop sepa cuáles son de su chat. */
  const live = new Set<{ key?: string; dropped: boolean; abort?: AbortController }>();
  const now = deps.now ?? Date.now;
  /**
   * Notas mandadas a la tele por chat (la tele se queda con ellas y siguen sonando). Se
   * guardan todas las de la ventana, no solo la última: dos casts seguidos tienen cada uno
   * su propio «parar» (servidor LAN, Glasshouse…) y /stop debe llamar a los dos.
   */
  const teleCasts = new Map<
    string | undefined,
    Array<{ at: number; stop?: () => Promise<unknown>; close?: () => void; stopped: boolean }>
  >();
  const noteTeleCast = (
    key: string | undefined,
    stop?: () => Promise<unknown>,
    close?: () => void,
  ) => {
    const window = deps.teleStopWindowMs ?? 120_000;
    const t = now();
    const kept = (teleCasts.get(key) ?? []).filter((e) => t - e.at <= window);
    const entry = { at: t, stop, close, stopped: false };
    kept.push(entry);
    teleCasts.set(key, kept);
    return entry;
  };
  /**
   * El aviso del firewall sale una sola vez por sesión, compartido con «reprodúcelo en
   * la tele» (src/tools/media.ts): repetirlo en cada nota o por cada camino cansa.
   */
  const watchFetch = (
    hits: (() => number) | undefined,
    onNotice?: (text: string) => void,
    stopped?: () => boolean,
  ) => {
    if (!hits || !onNotice || teleFirewallAlreadyWarned()) return;
    const timer = setTimeout(() => {
      // Parada con /stop antes de que la tele pidiera el fichero: no es el firewall.
      if (stopped?.() || teleFirewallAlreadyWarned()) return;
      let served = 1;
      try {
        served = hits();
      } catch {
        return;
      }
      if (served > 0 || !claimTeleFirewallWarning()) return;
      try {
        onNotice(`📺 ${TV_FIREWALL_HINT}`);
      } catch {
        // Un aviso que falla no puede romper nada.
      }
    }, deps.noFetchMs ?? 15_000);
    timer.unref?.();
  };
  const playOne = async (
    mode: 'pc' | 'tele',
    load: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
    item: { key?: string; dropped: boolean; abort?: AbortController },
    onNotice?: (text: string) => void,
  ): Promise<void> => {
    if (item.dropped) return;
    const got = await load();
    if (item.dropped) return;
    if (!got) throw new Error('no he podido descargar la nota de voz');
    const file = await deps.toPlayable(got.bytes, got.mimeType);
    if (item.dropped) {
      deps.remove(file);
      return;
    }
    if (mode === 'tele') {
      if (!deps.castToTv) {
        deps.remove(file);
        throw new Error('la tele no está activada (PA_AUDIO_TELE=1)');
      }
      const r = await deps.castToTv(file);
      if (!r.ok) throw new Error(r.message);
      if (item.dropped) {
        // /stop llegó mientras la tele abría la nota (conectar puede tardar segundos):
        // antes la nota sonaba igual y /stop ya no la encontraba. Se para ya y se cierra
        // el servidor del audio, sin bloquear la cola si la tele tarda en contestar.
        const stop = r.stop ?? deps.stopTv;
        void Promise.resolve()
          .then(() => stop?.())
          .catch((err) => deps.onError?.(err))
          .finally(() => r.close?.());
        return;
      }
      const cast = noteTeleCast(item.key, r.stop, r.close);
      watchFetch(r.hits, onNotice, () => cast.stopped);
      return;
    }
    const abort = new AbortController();
    item.abort = abort;
    try {
      await deps.playOnPc(file, abort.signal);
    } catch (err) {
      // Cortada por /stop: no es un fallo que haya que contar.
      if (!item.dropped) throw err;
    } finally {
      deps.remove(file);
    }
  };
  /** Para en la tele la nota de ese chat (o de cualquiera sin `key`) si es reciente. */
  const stopRecentTele = (key?: string): number => {
    const { stopTv } = deps;
    const window = deps.teleStopWindowMs ?? 120_000;
    const t = now();
    // Cada «parar» con los servidores LAN de sus casts: se cierran cuando la tele ha
    // contestado (o ha fallado). Antes /stop paraba la tele pero el servidor del audio
    // seguía abierto, con el fichero, hasta el final de su ventana.
    const stops = new Map<() => Promise<unknown>, Array<() => void>>();
    const orphanCloses: Array<() => void> = [];
    for (const [k, list] of teleCasts) {
      if (key !== undefined && k !== key) continue;
      teleCasts.delete(k);
      for (const e of list) {
        if (t - e.at > window) continue;
        e.stopped = true;
        // El «parar» del propio cast (cierra el navegador/Glasshouse si hizo falta); si no, el genérico.
        const stop = e.stop ?? stopTv;
        if (stop) {
          const closes = stops.get(stop) ?? [];
          if (e.close) closes.push(e.close);
          stops.set(stop, closes);
        } else if (e.close) orphanCloses.push(e.close);
      }
    }
    const closeAll = (closes: Array<() => void>): void => {
      for (const close of closes) {
        try {
          close();
        } catch (err) {
          deps.onError?.(err);
        }
      }
    };
    closeAll(orphanCloses);
    if (!stops.size) return 0;
    for (const [stop, closes] of stops) {
      try {
        void Promise.resolve(stop())
          .catch((err) => deps.onError?.(err))
          .finally(() => closeAll(closes));
      } catch (err) {
        deps.onError?.(err);
        closeAll(closes);
      }
    }
    return 1;
  };
  return {
    enqueue(mode, load, onFail, key, onNotice) {
      if (waiting >= ALTAVOZ_MAX_QUEUE) return false;
      waiting++;
      const item: { key?: string; dropped: boolean; abort?: AbortController } = {
        key,
        dropped: false,
      };
      live.add(item);
      chain = chain
        .then(() => playOne(mode, load, item, onNotice))
        .catch((err) => {
          if (item.dropped) return;
          deps.onError?.(err);
          try {
            onFail?.(err);
          } catch {
            // Un aviso que falla no puede parar la cola.
          }
        })
        .finally(() => {
          live.delete(item);
          waiting--;
        });
      return true;
    },
    clear(key) {
      let stopped = 0;
      for (const item of live) {
        if (item.dropped || (key !== undefined && item.key !== key)) continue;
        item.dropped = true;
        item.abort?.abort();
        stopped++;
      }
      stopped += stopRecentTele(key);
      return stopped;
    },
    noteTele(key, stop, close) {
      const cast = noteTeleCast(key, stop, close);
      return { stopped: () => cast.stopped };
    },
    idle: () => chain,
    pending: () => waiting,
  };
}
