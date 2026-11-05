/**
 * Varias claves del MISMO proveedor que se turnan cuando una se queda sin cuota
 * o da 429 (gap #6: Hermes «credential pools», OpenClaw «auth profiles», Crocbot
 * «API key round-robin»). La primera es la de siempre (OPENCODE_GO_API_KEY,
 * vault provider:apiKey o PA_API_KEY); las de PA_EXTRA_API_KEYS son de reserva.
 *
 * - `current()` es la clave de la próxima petición. En cuanto la principal ha
 *   descansado (`cooldownMs`), se vuelve a ella sola.
 * - `rotate()` aparca la clave actual `cooldownMs` y pasa a la siguiente que no
 *   esté aparcada. false = no queda ninguna: toca el modelo de respaldo.
 * Las claves nunca salen de aquí: ni log ni texto, solo su posición.
 */
export class KeyPool {
  readonly #keys: string[];
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #restingUntil: number[];
  #index = 0;

  constructor(keys: readonly string[], opts: { cooldownMs?: number; now?: () => number } = {}) {
    this.#keys = [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ''))];
    this.#cooldownMs = opts.cooldownMs ?? KEY_COOLDOWN_MS;
    this.#now = opts.now ?? Date.now;
    this.#restingUntil = this.#keys.map(() => 0);
  }

  get size(): number {
    return this.#keys.length;
  }

  /** Posición (1, 2…) de la clave en uso, para el log. */
  get position(): number {
    return this.#index + 1;
  }

  current(): string | undefined {
    const now = this.#now();
    // Vuelta a la principal en cuanto ha descansado.
    if (this.#index !== 0 && (this.#restingUntil[0] ?? 0) <= now) this.#index = 0;
    return this.#keys[this.#index];
  }

  rotate(): boolean {
    if (this.#keys.length < 2) return false;
    const now = this.#now();
    this.#restingUntil[this.#index] = now + this.#cooldownMs;
    for (let step = 1; step < this.#keys.length; step++) {
      const i = (this.#index + step) % this.#keys.length;
      if ((this.#restingUntil[i] ?? 0) <= now) {
        this.#index = i;
        return true;
      }
    }
    return false;
  }
}

/** Una clave que dio 429/cuota descansa una hora antes de volver a probarse. */
export const KEY_COOLDOWN_MS = 60 * 60 * 1000;

/** PA_EXTRA_API_KEYS: claves de reserva separadas por comas o espacios (máx. 8). */
export function parseExtraKeys(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ].slice(0, 8);
}
