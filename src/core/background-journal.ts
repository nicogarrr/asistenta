import { createHash, randomUUID } from 'node:crypto';
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
  /** Id propio de cada ejecución: dos subtareas iguales a la vez no se pisan. */
  id: string;
  /** Hilo dueño (chatKey + '#' + nombre): a él vuelve el resultado al retomarla. */
  threadKey: string;
  /** La tarea tal cual se delegó; es lo único que hace falta para repetirla. */
  task: string;
  /** Cuándo se arrancó (epoch ms): pasado el tope de edad ya no se retoma. */
  startedAt: number;
  /** Rol del hijo tal cual se pidió: al retomar se reaplica (un planner no pasa a explorer). */
  role?: 'explorer' | 'planner' | 'implementer';
  /** Herramientas pedidas (también `[]`): al retomar se reaplican, nunca se amplían. */
  tools?: string[];
  /**
   * Nota de resultado ya calculada, aún sin entrega confirmada. Mientras exista, la
   * entrada se conserva: al arrancar se entrega sin repetir la subtarea.
   */
  result?: string;
}

/** Lo que se pasa a `add`: sin `id` se le asigna uno nuevo. */
export type NewBackgroundJob = Omit<PersistedBackgroundJob, 'id'> & { id?: string };

const ROLES = ['explorer', 'planner', 'implementer'];

/** Una subtarea de más de un día ya no se retoma: el contexto que la pidió quedó viejo. */
export const BACKGROUND_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tope de entradas guardadas: el diario no puede crecer sin límite aunque algo falle. */
export const BACKGROUND_JOB_KEEP = 20;

function isJob(value: unknown): value is NewBackgroundJob {
  if (typeof value !== 'object' || value === null) return false;
  const j = value as Record<string, unknown>;
  return (
    typeof j.threadKey === 'string' &&
    j.threadKey.length > 0 &&
    typeof j.task === 'string' &&
    j.task.length > 0 &&
    typeof j.startedAt === 'number' &&
    (j.id === undefined || (typeof j.id === 'string' && j.id.length > 0)) &&
    (j.role === undefined || (typeof j.role === 'string' && ROLES.includes(j.role))) &&
    (j.tools === undefined ||
      (Array.isArray(j.tools) && j.tools.every((t) => typeof t === 'string'))) &&
    (j.result === undefined || typeof j.result === 'string')
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
      if (!Array.isArray(data)) return [];
      // Una entrada sin id (formato antiguo) recibe uno estable derivado de su contenido.
      return data
        .filter(isJob)
        .map((e) => ({
          ...e,
          id:
            e.id ??
            `legacy-${createHash('sha1').update(`${e.threadKey}\n${e.task}\n${e.startedAt}`).digest('hex').slice(0, 16)}`,
        }))
        .slice(-BACKGROUND_JOB_KEEP);
    } catch (err) {
      log.warn('background job journal unreadable, ignoring', { err });
      return [];
    }
  }

  /** Anota (o reemplaza, si el id ya existe) la entrada y devuelve su id. */
  add(job: NewBackgroundJob): string {
    const id = job.id ?? randomUUID();
    const rest = this.all().filter((e) => e.id !== id);
    this.#write([...rest, { ...job, id }].slice(-BACKGROUND_JOB_KEEP));
    return id;
  }

  /** Guarda el resultado de la ejecución `id`; la entrada sigue hasta `remove`. */
  complete(id: string, result: string): void {
    const all = this.all();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return;
    all[idx] = { ...(all[idx] as PersistedBackgroundJob), result };
    this.#write(all);
  }

  remove(id: string): void {
    const all = this.all();
    const next = all.filter((e) => e.id !== id);
    if (next.length === all.length) return;
    this.#write(next);
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
