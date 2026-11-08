/**
 * Del movimiento del iPhone a una dirección de apuntado (az, el en grados).
 *
 * Misma idea que MotionAim de AimMac (MIT): el borde de arriba del móvil es el puntero.
 *   el  sale de la gravedad, así que arriba/abajo no deriva.
 *   az  suma los giros alrededor de la vertical real con el giroscopio (deriva con el
 *       tiempo: por eso existe «Centrar»).
 *
 * Entrada (la manda la página web de Safari, DeviceMotionEvent):
 *   g = accelerationIncludingGravity (m/s², «reacción a la gravedad» según la especificación:
 *       con el móvil tumbado boca arriba, z ≈ +9,8; de pie, y ≈ +9,8). Se convierte a vector
 *       de gravedad con -g. Se apunta con el móvil como un mando: casi horizontal, borde de
 *       arriba hacia la pantalla (de pie, el borde de arriba apunta al cielo: el = 90°).
 *   r = [beta, gamma, alpha] de rotationRate en °/s, es decir giro alrededor de x, y, z del móvil.
 * shortcut: los signos de Safari en iOS no se han comprobado con un iPhone real; la página tiene
 * «Invertir ↑↓» y «Invertir ←→». Mejorar cuando se mida con el móvil de Nico.
 */
export interface MotionSample {
  t: number;
  g: [number, number, number];
  r: [number, number, number];
}

export class MotionAim {
  private az = 0;
  private lastT: number | undefined;
  /** +1 normal, -1 invertido. */
  invertEl = false;
  invertAz = false;

  /** Devuelve {az, el} en grados (az crece girando a la izquierda, el crece inclinando hacia arriba) o null si no hay gravedad válida. */
  process(s: MotionSample): { az: number; el: number } | null {
    // Vector de gravedad (apunta hacia abajo): la reacción que mide el móvil, cambiada de signo.
    const gx = -s.g[0];
    const gy = -s.g[1];
    const gz = -s.g[2];
    const gn = Math.hypot(gx, gy, gz);
    if (!(gn > 1)) return null;
    const ux = gx / gn;
    const uy = gy / gn;
    const uz = gz / gn;
    // arriba/abajo: cuánto sube el borde +Y sobre el horizonte
    let el = (Math.asin(Math.max(-1, Math.min(1, -uy))) * 180) / Math.PI;
    if (this.invertEl) el = -el;
    // izquierda/derecha: giro alrededor de «arriba» (= -gravedad), positivo = hacia la izquierda
    const [wx, wy, wz] = s.r;
    const wUp = -(wx * ux + wy * uy + wz * uz);
    if (this.lastT !== undefined) {
      const dt = Math.min(Math.max(s.t - this.lastT, 0), 0.05);
      this.az += (this.invertAz ? -wUp : wUp) * dt;
      if (this.az > 360 || this.az < -360) this.az %= 360;
    }
    this.lastT = s.t;
    return { az: this.az, el };
  }

  resetAzimuth(): void {
    this.az = 0;
  }
}
