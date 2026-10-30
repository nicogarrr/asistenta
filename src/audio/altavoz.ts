import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
    .replace(/[\u0300-\u036f]/g, '');
  if (!a || a === 'estado') return { kind: 'show' };
  if (/^(on|si|pc|ordenador|enciende|activa|activar)$/.test(a)) return { kind: 'set', mode: 'pc' };
  if (/^(tele|tv|television)$/.test(a)) return { kind: 'set', mode: 'tele' };
  if (/^(off|no|apaga|apagar|desactiva|desactivar|para)$/.test(a)) {
    return { kind: 'set', mode: 'off' };
  }
  return { kind: 'error' };
}

export function altavozStatusText(mode: AltavozMode): string {
  switch (mode) {
    case 'pc':
      return '🔊 Altavoz activado: tus notas de voz sonarán en el PC al llegar. /altavoz off para quitarlo.';
    case 'tele':
      return '📺 Altavoz activado en la tele: tus notas de voz sonarán en la tele al llegar. /altavoz off para quitarlo.';
    default:
      return '🔇 Altavoz apagado. /altavoz pc o /altavoz tele para que tus notas de voz suenen solas.';
  }
}

export const ALTAVOZ_USAGE =
  'Uso: /altavoz pc · /altavoz tele · /altavoz off · /altavoz (ver estado)';

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
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#modes, null, 2));
    renameSync(tmp, this.#file);
  }
}

export interface AltavozPlayerDeps {
  /** Convierte los bytes recibidos en un fichero reproducible (MP3). */
  toPlayable(bytes: Buffer, mimeType: string): Promise<string>;
  /** Suena un fichero en el PC sin tocar el volumen; se resuelve al acabar. */
  playOnPc(file: string): Promise<void>;
  /** Manda un fichero a la tele (se queda con él). Ausente si la tele está apagada. */
  castToTv?: (file: string) => Promise<{ ok: boolean; message: string }>;
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
  ): boolean;
  /** Promesa de la cola actual (para pruebas y para /stop). */
  idle(): Promise<void>;
  pending(): number;
}

/**
 * Cola en serie: dos notas seguidas suenan una detrás de otra, nunca a la vez, y un
 * fallo en una no para las siguientes.
 */
export function createAltavozPlayer(deps: AltavozPlayerDeps): AltavozPlayer {
  let chain: Promise<void> = Promise.resolve();
  let waiting = 0;
  const playOne = async (
    mode: 'pc' | 'tele',
    load: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
  ): Promise<void> => {
    const got = await load();
    if (!got) throw new Error('no he podido descargar la nota de voz');
    const file = await deps.toPlayable(got.bytes, got.mimeType);
    if (mode === 'tele') {
      if (!deps.castToTv) {
        deps.remove(file);
        throw new Error('la tele no está activada (PA_AUDIO_TELE=1)');
      }
      const r = await deps.castToTv(file);
      if (!r.ok) throw new Error(r.message);
      return;
    }
    try {
      await deps.playOnPc(file);
    } finally {
      deps.remove(file);
    }
  };
  return {
    enqueue(mode, load) {
      if (waiting >= ALTAVOZ_MAX_QUEUE) return false;
      waiting++;
      chain = chain
        .then(() => playOne(mode, load))
        .catch((err) => deps.onError?.(err))
        .finally(() => {
          waiting--;
        });
      return true;
    },
    idle: () => chain,
    pending: () => waiting,
  };
}
