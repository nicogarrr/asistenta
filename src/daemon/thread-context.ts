/**
 * Contexto tipado por conversación: a dónde va lo que un turno envía aparte de su
 * respuesta (una captura, un archivo) y con qué Gate se aprueba.
 *
 * Hasta ahora cada herramienta que manda algo al chat cerraba sobre Telegram a mano
 * (`telegram.sendPhotoBytes(chatId…)`), así que una captura pedida desde el panel web
 * salía por el Telegram del dueño aunque el turno fuera del panel (#656). Aquí el hilo
 * sabe si su turno vivo tiene otro destino (`TurnOutput`, el panel) y lo usa; sin ese
 * destino todo va por el canal exactamente como antes.
 *
 * Es el paso previo a Computer Use como plugin (ARCHITECTURE.md §5): el plugin recibirá
 * este contexto en vez de los cierres de cli.ts.
 */
import type { TurnOutput } from './panel-chat.js';

/** Qué salida tiene ahora mismo cada hilo (solo mientras su turno corre). */
export class ThreadOutputs {
  private readonly live = new Map<string, TurnOutput>();

  /** Al empezar un turno: con `out` lo que se envíe va allí; sin él, al canal. */
  bind(key: string, out: TurnOutput | undefined): void {
    if (out) this.live.set(key, out);
    else this.live.delete(key);
  }

  /** Al acabar el turno: suelta su salida (si no la ha sustituido ya otro turno). */
  release(key: string, out: TurnOutput | undefined): void {
    if (out && this.live.get(key) === out) this.live.delete(key);
  }

  get(key: string): TurnOutput | undefined {
    return this.live.get(key);
  }
}

export interface ThreadContextDeps<G> {
  key: string;
  outputs: ThreadOutputs;
  /** El Gate de ESTE hilo: las aprobaciones de esta conversación y de nadie más. */
  gate: G;
}

export interface ThreadContext<G> {
  key: string;
  /** El destino del turno vivo, si no es el canal (el panel). */
  output(): TurnOutput | undefined;
  /** El Gate del hilo, el mismo que antes cerraba cada tool por su cuenta. */
  gate: G;
  /**
   * Manda una imagen a la conversación. En un turno del panel va al panel y
   * `viaChannel` no se llama (nada sale por Telegram, ni «enviando foto…»); si no,
   * es exactamente `viaChannel()`, con su resultado y sus errores.
   */
  sendPhoto<T>(bytes: Buffer, viaChannel: () => Promise<T>): Promise<T | true>;
}

export function threadContext<G>(deps: ThreadContextDeps<G>): ThreadContext<G> {
  return {
    key: deps.key,
    output: () => deps.outputs.get(deps.key),
    gate: deps.gate,
    sendPhoto: async <T>(bytes: Buffer, viaChannel: () => Promise<T>): Promise<T | true> => {
      const out = deps.outputs.get(deps.key);
      if (out?.photo) {
        out.photo(bytes);
        return true;
      }
      return viaChannel();
    },
  };
}
