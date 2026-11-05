import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './log.js';
import { fechaCortaEs } from './tools/reminder.js';

/**
 * Historial de ejecuciones de cada rutina: cuándo corrió, si salió bien o falló,
 * adónde fue la salida y un trozo de ella. Antes solo quedaba `lastRunAt`: de un
 * «el informe de ayer no llegó» no había forma de saber qué pasó sin abrir el log.
 */
export type RoutineDelivery =
  /** Llegó al chat a su hora. */
  | 'chat'
  /** Telegram no la aceptó: pendiente de reenvío (cola en disco). */
  | 'pendiente'
  /** Llegó al chat más tarde, en un reenvío. */
  | 'reenviada'
  /** Se guardó en un fichero (F6). */
  | 'fichero'
  /** No se mandó: igual que la anterior («solo si cambia») o un fallo repetido. */
  | 'sin-cambios'
  /** Entrega a ningún sitio (F6). */
  | 'ninguno'
  /** Sin conexión con el modelo: se reintenta más tarde. */
  | 'reintento';

export interface RoutineRun {
  /** Inicio (ms epoch). */
  at: number;
  ok: boolean;
  /** Duración del trabajo en ms. */
  ms: number;
  entrega: RoutineDelivery;
  /** Primeras líneas de la salida (o del error). */
  salida: string;
}

/** Ejecuciones que se guardan por rutina (las más recientes). */
export const HISTORY_PER_ROUTINE = 10;
/**
 * Rutinas distintas con historial como mucho. Cada recordatorio de una vez es una rutina
 * que se borra al sonar y su historial se quedaba para siempre: pasado el tope se olvidan
 * las que llevan más tiempo sin ejecutarse.
 */
export const HISTORY_ROUTINES = 200;
/** Caracteres de salida que se guardan por ejecución. */
export const HISTORY_OUTPUT_CHARS = 300;

const keyOf = (scope: string, name: string): string => `${scope}\u0000${name}`;

function isRun(x: unknown): x is RoutineRun {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.at === 'number' &&
    typeof o.ok === 'boolean' &&
    typeof o.ms === 'number' &&
    typeof o.entrega === 'string' &&
    typeof o.salida === 'string'
  );
}

export function clipOutput(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > HISTORY_OUTPUT_CHARS
    ? `${chars.slice(0, HISTORY_OUTPUT_CHARS - 1).join('')}…`
    : flat;
}

/**
 * Un JSON pequeño (10 ejecuciones × rutina, salida recortada): escritura atómica y
 * un fichero ilegible se trata como vacío; nunca tumba una rutina.
 */
export class RoutineHistory {
  readonly #path: string;
  readonly #createdAtOf: ((scope: string, name: string) => string | undefined) | undefined;
  /**
   * `createdAtOf`: cuándo se creó la rutina que hoy lleva ese nombre. Con él, `list` no
   * enseña ejecuciones de antes: borrar «resumen» y crear otra «resumen» ya no hereda el
   * historial (ni el «❌ la última falló») de la vieja.
   */
  constructor(path: string, createdAtOf?: (scope: string, name: string) => string | undefined) {
    this.#path = path;
    this.#createdAtOf = createdAtOf;
  }

  #read(): Record<string, RoutineRun[]> {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return {};
    }
    try {
      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const out: Record<string, RoutineRun[]> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (Array.isArray(v)) out[k] = v.filter(isRun);
      }
      return out;
    } catch (err) {
      log.warn('routine history unreadable, ignoring', { err });
      return {};
    }
  }

  #write(data: Record<string, RoutineRun[]>): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.#path);
    } catch (err) {
      log.warn('routine history write failed', { err });
    }
  }

  /** Apunta una ejecución (las más recientes primero; como mucho HISTORY_PER_ROUTINE). */
  record(scope: string, name: string, run: RoutineRun): void {
    const data = this.#read();
    const k = keyOf(scope, name);
    const runs = [{ ...run, salida: clipOutput(run.salida) }, ...(data[k] ?? [])];
    delete data[k];
    data[k] = runs.slice(0, HISTORY_PER_ROUTINE);
    const keys = Object.keys(data);
    if (keys.length > HISTORY_ROUTINES) {
      const lastAt = (key: string): number => data[key]?.[0]?.at ?? 0;
      const oldest = keys
        .filter((key) => key !== k)
        .sort((a, b) => lastAt(a) - lastAt(b))
        .slice(0, keys.length - HISTORY_ROUTINES);
      for (const key of oldest) delete data[key];
    }
    this.#write(data);
  }

  /** La última ejecución pendiente de reenvío ya llegó al chat. */
  markResent(scope: string, name: string): void {
    const data = this.#read();
    const last = data[keyOf(scope, name)]?.[0];
    if (!last || last.entrega !== 'pendiente') return;
    last.entrega = 'reenviada';
    this.#write(data);
  }

  /** Ejecuciones de una rutina, la más reciente primero. */
  list(scope: string, name: string): RoutineRun[] {
    const runs = this.#read()[keyOf(scope, name)] ?? [];
    const born = Date.parse(this.#createdAtOf?.(scope, name) ?? '');
    // Un segundo de margen: la primera ejecución puede apuntarse en el mismo instante.
    return Number.isFinite(born) ? runs.filter((r) => r.at >= born - 1000) : runs;
  }

  /** Olvida el historial de una rutina borrada. */
  forget(scope: string, name: string): void {
    const data = this.#read();
    const k = keyOf(scope, name);
    if (!(k in data)) return;
    delete data[k];
    this.#write(data);
  }
}

/** El historial de rutinas de una carpeta de estado (sin estado propio: lee el fichero). */
export function routineHistoryAt(
  stateDir: string,
  createdAtOf?: (scope: string, name: string) => string | undefined,
): RoutineHistory {
  return new RoutineHistory(join(stateDir, 'rutinas-historial.json'), createdAtOf);
}

const ENTREGA_ES: Record<RoutineDelivery, string> = {
  chat: 'enviada',
  pendiente: 'Telegram no la aceptó, pendiente de reenvío',
  reenviada: 'enviada con retraso',
  fichero: 'guardada en fichero',
  'sin-cambios': 'no enviada: sin cambios',
  ninguno: 'no enviada (entrega: ninguno)',
  reintento: 'sin conexión con el modelo, se reintenta',
};

function duracionEs(ms: number): string {
  if (ms < 1000) return 'menos de 1 s';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** Una línea por ejecución: «✅ jue 05/11 08:00 · 12 s · enviada — 3 correos nuevos…». */
export function formatRun(run: RoutineRun): string {
  const icono = run.ok ? '✅' : '❌';
  const salida = run.salida
    ? ` — ${run.salida.length > 120 ? `${Array.from(run.salida).slice(0, 119).join('')}…` : run.salida}`
    : '';
  return `${icono} ${fechaCortaEs(new Date(run.at))} · ${duracionEs(run.ms)} · ${ENTREGA_ES[run.entrega] ?? run.entrega}${salida}`;
}

/** Respuesta de «/cron historial <rutina>». */
export function formatHistory(name: string, runs: readonly RoutineRun[]): string {
  if (!runs.length) return `La rutina "${name}" todavía no tiene ejecuciones apuntadas.`;
  const fallos = runs.filter((r) => !r.ok).length;
  return [
    `Últimas ejecuciones de "${name}" (${runs.length}${fallos ? `, ${fallos} con fallo` : ', todas bien'}):`,
    ...runs.map(formatRun),
  ].join('\n');
}
