/**
 * Cuánto tarda el asistente en contestar en Telegram, para /estado.
 *
 * «Va lento» no se podía comprobar: el log no guardaba la duración de cada
 * respuesta y /estado no decía nada de la velocidad. Aquí se guardan las
 * últimas respuestas (acotado: nunca crece) con el tiempo desde que llegó el
 * mensaje hasta que salió la respuesta, y cuánto esperó en cola detrás de otra
 * tarea de la misma conversación. Solo en memoria: se cuenta desde que arrancó.
 */

export interface LatencySummary {
  count: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Mediana de la espera en cola antes de empezar a pensar. */
  waitMedianMs: number;
}

/** Percentil por el método del rango más cercano (p entre 0 y 100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export class LatencyStats {
  readonly #cap: number;
  readonly #total: number[] = [];
  readonly #wait: number[] = [];

  constructor(cap = 100) {
    this.#cap = Math.max(1, cap);
  }

  /** Una respuesta: `totalMs` desde que llegó el mensaje, `waitMs` en cola. */
  record(totalMs: number, waitMs = 0): void {
    if (!Number.isFinite(totalMs) || totalMs < 0) return;
    const wait = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, totalMs) : 0;
    this.#total.push(totalMs);
    this.#wait.push(wait);
    if (this.#total.length > this.#cap) {
      this.#total.shift();
      this.#wait.shift();
    }
  }

  get size(): number {
    return this.#total.length;
  }

  summary(): LatencySummary | null {
    if (!this.#total.length) return null;
    const total = [...this.#total].sort((a, b) => a - b);
    const wait = [...this.#wait].sort((a, b) => a - b);
    return {
      count: total.length,
      medianMs: percentile(total, 50),
      p95Ms: percentile(total, 95),
      maxMs: total[total.length - 1] ?? 0,
      waitMedianMs: percentile(wait, 50),
    };
  }
}

/** «4,2 s», «0,3 s», «1 min 5 s». */
export function secondsEs(ms: number): string {
  if (ms >= 60_000) {
    const s = Math.round(ms / 1000);
    const rest = s % 60;
    return `${Math.floor(s / 60)} min${rest ? ` ${rest} s` : ''}`;
  }
  return `${(ms / 1000).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** Línea de /estado. Sin respuestas todavía, lo dice. */
export function latencyLine(s: LatencySummary | null): string {
  if (!s) return 'Velocidad: aún no he contestado nada desde que arranqué.';
  const n = `${s.count} ${s.count === 1 ? 'respuesta' : 'respuestas'}`;
  const wait =
    s.waitMedianMs >= 1000 ? `; esperando en cola ${secondsEs(s.waitMedianMs)} de mediana` : '';
  return `Velocidad (últimas ${n}): ${secondsEs(s.medianMs)} de mediana, el 95 % en menos de ${secondsEs(s.p95Ms)}, la más lenta ${secondsEs(s.maxMs)}${wait}.`;
}
