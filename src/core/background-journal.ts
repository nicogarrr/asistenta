import { readFileSync } from 'node:fs';
import { writeFileReplacing } from '../fs-tmp.js';
import { log } from '../log.js';

/**
 * Diario de subtareas en segundo plano (delegate con `background: true`).
 *
 * La cola vive en memoria (core/background-delegate.ts): un reinicio del daemon
 * (la autoactualización, un apagón) cortaba la subtarea a medias y su resultado
 * no llegaba nunca, sin aviso. Este diario deja cada subtarea en disco al
 * arrancarla y la quita al terminar (bien, mal o cortada con /stop); al arrancar
 * el daemon las retoma solas (ver cli.ts). El hijo es de solo lectura, así que
 * repetirla es seguro: el mismo criterio que el reintento por caída de red.
 */
export interface PersistedBackgroundJob {
  /** Hilo dueño (chatKey + '#' + nombre): a él vuelve el resultado al retomarla. */
  threadKey: string;
  /** La tarea tal cual se delegó; es lo único que hace falta para repetirla. */
  task: string;
  /** Cuándo se arrancó (epoch ms): pasado el tope de edad ya no se retoma. */
  startedAt: number;
}

/** Una subtarea de más de un día ya no se retoma: el contexto que la pidió quedó viejo. */
export const BACKGROUND_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tope de entradas guardadas: el diario no puede crecer sin límite aunque algo falle. */
export const BACKGROUND_JOB_KEEP = 20;

function isJob(value: unknown): value is PersistedBackgroundJob {
  if (typeof value !== 'object' || value === null) return false;
  const j = value as Record<string, unknown>;
  return (
    typeof j.threadKey === 'string' &&
    j.threadKey.length > 0 &&
    typeof j.task === 'string' &&
    j.task.length > 0 &&
    typeof j.startedAt === 'number'
  );
}

/**
 * Un JSON pequeño (como mucho una entrada por subtarea en marcha). Escritura
 * atómica (tmp + rename): un apagón a mitad no deja el fichero roto. Un fichero
 * ilegible se trata como vacío; el diario nunca tumba el daemon.
 */
export class BackgroundJobJournal {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }

  all(): PersistedBackgroundJob[] {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return [];
    }
    try {
      const data: unknown = JSON.parse(raw);
      return Array.isArray(data) ? data.filter(isJob).slice(-BACKGROUND_JOB_KEEP) : [];
    } catch (err) {
      log.warn('background job journal unreadable, ignoring', { err });
      return [];
    }
  }

  add(job: PersistedBackgroundJob): void {
    const rest = this.all().filter((e) => !(e.threadKey === job.threadKey && e.task === job.task));
    this.#write([...rest, job].slice(-BACKGROUND_JOB_KEEP));
  }

  remove(threadKey: string, task: string): void {
    const all = this.all();
    const idx = all.findIndex((e) => e.threadKey === threadKey && e.task === task);
    if (idx === -1) return;
    all.splice(idx, 1);
    this.#write(all);
  }

  #write(entries: PersistedBackgroundJob[]): void {
    try {
      writeFileReplacing(this.#path, JSON.stringify(entries));
    } catch (err) {
      // Una subtarea sin diario se pierde en un reinicio, como antes de existir.
      log.warn('background job journal write failed', { err });
    }
  }
}
