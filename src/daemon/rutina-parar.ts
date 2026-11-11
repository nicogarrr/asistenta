/**
 * «/cron parar <rutina>» (idea de Hermes: parar un trabajo programado en marcha).
 *
 * Antes, una rutina que se alargaba (un informe que se quedó navegando, una que repite
 * pasos) solo se cortaba con /stop, que para TODO lo del chat. Ahora cada ejecución de
 * rutina se apunta aquí mientras corre (o espera turno en su hilo) y se puede cortar
 * sola: si aún no empezó, no empieza; si está corriendo, se aborta el turno del agente
 * de ese hilo. Lo que hubiera escrito a medias no se manda, y el historial dice
 * «parada por ti». La rutina sigue programada: la próxima vez suena normal.
 */

/** Ejecución cortada con «/cron parar»: quien la lanzó no manda nada al chat. */
export class RoutineStoppedError extends Error {
  constructor(name: string) {
    super(`rutina "${name}" parada por el dueño`);
    this.name = 'RoutineStoppedError';
  }
}

export interface RoutineStopHandle {
  /** Se pidió parar esta ejecución. */
  readonly stopped: boolean;
  /** La ejecución empezó a correr de verdad (salió de la cola del hilo). */
  started(abort: () => void): void;
  /** Terminó (bien, mal o parada): sale del registro. */
  end(): void;
}

export type StopOutcome = 'parada' | 'en-cola' | 'no-en-curso';

const key = (scope: string, name: string): string => `${scope}\u0000${name}`;

interface Entry {
  stopped: boolean;
  abort: (() => void) | null;
}

export class RoutineStops {
  readonly #runs = new Map<string, Set<Entry>>();

  /** Apunta una ejecución de la rutina; devuelve su asa. */
  begin(scope: string, name: string): RoutineStopHandle {
    const k = key(scope, name);
    const entry: Entry = { stopped: false, abort: null };
    let set = this.#runs.get(k);
    if (!set) {
      set = new Set();
      this.#runs.set(k, set);
    }
    set.add(entry);
    return {
      get stopped() {
        return entry.stopped;
      },
      started: (abort) => {
        entry.abort = abort;
      },
      end: () => {
        const s = this.#runs.get(k);
        s?.delete(entry);
        if (s && s.size === 0) this.#runs.delete(k);
      },
    };
  }

  /** ¿Hay alguna ejecución de esa rutina corriendo o esperando turno? */
  isActive(scope: string, name: string): boolean {
    return (this.#runs.get(key(scope, name))?.size ?? 0) > 0;
  }

  /**
   * Corta todas las ejecuciones de esa rutina. «parada» si alguna corría (se abortó su
   * turno), «en-cola» si solo esperaban turno (no llegarán a empezar).
   */
  stop(scope: string, name: string): StopOutcome {
    const set = this.#runs.get(key(scope, name));
    if (!set || set.size === 0) return 'no-en-curso';
    let running = false;
    for (const entry of set) {
      if (entry.stopped) continue;
      entry.stopped = true;
      if (entry.abort) {
        running = true;
        try {
          entry.abort();
        } catch {}
      }
    }
    return running ? 'parada' : 'en-cola';
  }
}
