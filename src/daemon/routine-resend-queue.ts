import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.js';

/**
 * Informe de una rutina ya hecho que Telegram no aceptó y espera reenvío (#2036).
 * Antes vivía solo en memoria: un reinicio del PC o del daemon con el informe de
 * las 8:00 pendiente lo perdía. Ahora queda en disco y se reenvía al arrancar.
 */
export interface PendingResend {
  scope: string;
  routine: string;
  chatId: string;
  /** La salida tal cual se hizo (no se vuelve a trabajar). */
  body: string;
  /** Huella de la salida para «solo si cambia» (se confirma al entregarla). */
  hash: string;
  /** Cuándo se disparó la rutina (para la nota «con X de retraso»). */
  firstAt: number;
  /** Índice del próximo reenvío en la lista de esperas. */
  attempt: number;
  /** Cuándo toca el próximo reenvío. */
  dueAt: number;
}

/** Un informe pendiente de más de un día ya no se manda: el siguiente disparo lo sustituye. */
export const RESEND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const keyOf = (scope: string, routine: string): string => `${scope}\u0000${routine}`;

function isPending(x: unknown): x is PendingResend {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.scope === 'string' &&
    typeof o.routine === 'string' &&
    typeof o.chatId === 'string' &&
    typeof o.body === 'string' &&
    typeof o.hash === 'string' &&
    typeof o.firstAt === 'number' &&
    typeof o.attempt === 'number' &&
    typeof o.dueAt === 'number'
  );
}

/**
 * Cola en un JSON pequeño (como mucho una entrada por rutina). Escritura atómica
 * (tmp + rename): un apagón a mitad no deja el fichero roto. Un fichero ilegible
 * se trata como vacío; nunca tumba el daemon.
 */
export class RoutineResendQueue {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }

  all(): PendingResend[] {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch {
      return [];
    }
    try {
      const data = JSON.parse(raw) as unknown;
      return Array.isArray(data) ? data.filter(isPending) : [];
    } catch (err) {
      log.warn('routine resend queue unreadable, ignoring', { err });
      return [];
    }
  }

  put(entry: PendingResend): void {
    const k = keyOf(entry.scope, entry.routine);
    const rest = this.all().filter((e) => keyOf(e.scope, e.routine) !== k);
    this.#write([...rest, entry]);
  }

  remove(scope: string, routine: string): void {
    const all = this.all();
    const k = keyOf(scope, routine);
    const rest = all.filter((e) => keyOf(e.scope, e.routine) !== k);
    if (rest.length !== all.length) this.#write(rest);
  }

  #write(entries: PendingResend[]): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries));
      renameSync(tmp, this.#path);
    } catch (err) {
      log.warn('routine resend queue write failed', { err });
    }
  }
}
