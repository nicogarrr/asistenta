/**
 * Filtro 1€ (Casiez, Roussel, Vogel; https://gery.casiez.net/1euro/): estable con la mano
 * quieta, rápido cuando se mueve. Reescrito aquí a partir de la forma del de AimMac
 * (Coolerwave/AimMac, MIT; ver THIRD_PARTY_NOTICES.md); no se ha copiado código Swift.
 */
export class OneEuro {
  private xPrev: number | undefined;
  private dxPrev = 0;
  private tPrev = 0;
  private readonly dCutoff = 1;

  minCutoff: number;
  beta: number;

  constructor(minCutoff: number, beta: number) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** `t` en segundos, del reloj de quien manda la muestra. */
  filter(x: number, t: number): number {
    if (this.xPrev === undefined) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.min(Math.max(t - this.tPrev, 0.001), 0.1);
    this.tPrev = t;
    const dx = (x - this.xPrev) / dt;
    const ad = this.alpha(this.dCutoff, dt);
    this.dxPrev = ad * dx + (1 - ad) * this.dxPrev;
    const a = this.alpha(this.minCutoff + this.beta * Math.abs(this.dxPrev), dt);
    const r = a * x + (1 - a) * this.xPrev;
    this.xPrev = r;
    return r;
  }

  reset(): void {
    this.xPrev = undefined;
    this.dxPrev = 0;
  }
}
