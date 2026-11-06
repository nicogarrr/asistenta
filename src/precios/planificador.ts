/**
 * Cuándo barre el vigilante de precios de Amazon.es. Reloj de pared (no `setInterval` por
 * barrido): cada minuto mira qué toca, así que un barrido atrasado sale en cuanto vuelve a
 * haber reloj. También de noche: en horas de silencio barre más despacio (×`factorNoche`),
 * pero barre, porque los errores de precio también salen de madrugada. El aviso «🚨 ERROR
 * DE PRECIO» no espera al silencio; lo demás del vigilante no manda nada por su cuenta.
 */
export type TipoBarrido = 'normal' | 'rapido';

export interface DepsPlan {
  barrer(rapido: boolean): Promise<unknown>;
  /** Minutos entre barridos normales. */
  cadaMin: number;
  /** Minutos (±25 %) entre barridos rápidos; 0 = sin barrido rápido. */
  rapidoMin: number;
  /** ¿Es hora de silencio del dueño? */
  silencio(now: number): boolean;
  /** En horas de silencio el intervalo se multiplica por esto (por defecto 2). */
  factorNoche?: number;
  /** Espera hasta el primer barrido normal (por defecto 2 min). */
  primeraMs?: number;
  /** Se llama en cada tick (p. ej. el resumen diario de las 21:00); decide él si toca. */
  cadaTick?: () => Promise<unknown>;
  now?: () => number;
  azar?: () => number;
}

const MIN = 60_000;
/** Un barrido colgado (Chrome que no contesta tras suspender el portátil) no frena el plan. */
const ATASCO_MS = 30 * MIN;

export class PlanPrecios {
  readonly #d: DepsPlan;
  readonly #prox: Record<TipoBarrido, number>;
  /** Inicio del barrido en curso, o null. */
  #enCurso: number | null = null;

  constructor(d: DepsPlan) {
    this.#d = d;
    const now = this.#now();
    this.#prox = {
      normal: now + (d.primeraMs ?? 2 * MIN),
      rapido: now + this.intervalo('rapido', now),
    };
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  /** Milisegundos hasta el siguiente barrido de ese tipo si acabara ahora. */
  intervalo(tipo: TipoBarrido, now: number): number {
    const noche = this.#d.silencio(now) ? Math.max(1, this.#d.factorNoche ?? 2) : 1;
    if (tipo === 'normal') return this.#d.cadaMin * MIN * noche;
    const azar = 0.75 + (this.#d.azar ?? Math.random)() * 0.5;
    return Math.round(this.#d.rapidoMin * MIN * azar * noche);
  }

  /** Próximo barrido de cada tipo (marca de tiempo), para /precios y los tests. */
  proximo(tipo: TipoBarrido): number {
    return this.#prox[tipo];
  }

  /** Corre como mucho un barrido si toca. Devuelve cuál corrió. No lanza. */
  async tick(): Promise<TipoBarrido | null> {
    void this.#d.cadaTick?.().catch(() => null);
    const now = this.#now();
    if (this.#enCurso !== null && now - this.#enCurso < ATASCO_MS) return null;
    const tipo: TipoBarrido | null =
      now >= this.#prox.normal
        ? 'normal'
        : this.#d.rapidoMin > 0 && now >= this.#prox.rapido
          ? 'rapido'
          : null;
    if (!tipo) return null;
    const mio = now;
    this.#enCurso = mio;
    // Si se cuelga, el próximo de este tipo queda para dentro de ATASCO_MS + intervalo.
    this.#prox[tipo] = now + ATASCO_MS;
    try {
      await this.#d.barrer(tipo === 'rapido').catch(() => null);
    } finally {
      if (this.#enCurso === mio) {
        this.#enCurso = null;
        const fin = this.#now();
        this.#prox[tipo] = fin + this.intervalo(tipo, fin);
      }
    }
    return tipo;
  }

  /** Mira cada `cadaMs` (por defecto 1 min) si toca barrer. Devuelve cómo pararlo. */
  arrancar(cadaMs = MIN): () => void {
    const t = setInterval(() => void this.tick(), cadaMs);
    t.unref?.();
    return () => clearInterval(t);
  }
}
