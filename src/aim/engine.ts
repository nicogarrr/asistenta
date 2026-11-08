import { MotionAim, type MotionSample } from './motion.js';
import { OneEuro } from './oneeuro.js';

/** Dónde acaba el apuntado: el ratón de Windows o el puntero de la tele. */
export interface AimSink {
  /** Tamaño de la pantalla (píxeles) sobre la que se proyecta. */
  readonly screen: { w: number; h: number };
  /** true: pone el cursor en (x, y). false: solo sabe moverse en relativo. */
  readonly absolute: boolean;
  moveTo?(x: number, y: number): void;
  moveBy?(dx: number, dy: number, dragging: boolean): void;
  down(): void;
  up(held: number): void;
  right(): void;
  scroll(dy: number): void;
}

/** Entradas que manda el móvil (ya validadas por el servidor). */
export type AimInput =
  | ({ k: 'm' } & MotionSample)
  | { k: 'down'; t: number }
  | { k: 'up'; t: number }
  | { k: 'right' }
  | { k: 'scroll'; dy: number }
  | { k: 'center' }
  | { k: 'pause'; on: boolean }
  | { k: 'invert'; el?: boolean; az?: boolean };

/** Ventana de la que sale la posición de un clic: el toque sacude el móvil justo antes. */
export const CLICK_LOOKBACK_S = 0.1;
/** Tras tocar, el cursor se queda quieto este rato (si no, el golpe del dedo lo mueve). */
export const CLICK_FREEZE_S = 0.15;

export class AimEngine {
  /** Grados de giro desde el centro hasta el borde de la pantalla. */
  rangeDeg = 28;
  private readonly motion = new MotionAim();
  private readonly fx = new OneEuro(1.2, 0.02);
  private readonly fy = new OneEuro(1.2, 0.02);
  private azOff = 0;
  private elOff = 0;
  private raw: { az: number; el: number } | null = null;
  private paused = false;
  private cur: { x: number; y: number } | null = null;
  private last: { x: number; y: number } | null = null;
  private history: Array<{ t: number; x: number; y: number }> = [];
  private downAt: number | null = null;
  private freezeUntil = 0;
  private lastT = 0;

  private readonly sink: AimSink;

  constructor(sink: AimSink) {
    this.sink = sink;
  }

  /** «Pared» a distancia d tal que girar rangeDeg llega al borde (como AimMac). */
  project(xDeg: number, yDeg: number): { x: number; y: number } {
    const { w, h } = this.sink.screen;
    const r = (Math.max(5, Math.min(80, this.rangeDeg)) * Math.PI) / 180;
    const d = w / 2 / Math.tan(r);
    const clampDeg = (v: number) => Math.max(-80, Math.min(80, v));
    const ax = (clampDeg(xDeg) * Math.PI) / 180;
    const ay = (clampDeg(yDeg) * Math.PI) / 180;
    const x = Math.max(0, Math.min(w - 1, w / 2 + d * Math.tan(ax)));
    const y = Math.max(0, Math.min(h - 1, h / 2 + d * Math.tan(ay)));
    return { x, y };
  }

  handle(input: AimInput): void {
    switch (input.k) {
      case 'm':
        this.onMotion(input);
        return;
      case 'center':
        if (this.raw) {
          this.azOff = this.raw.az;
          this.elOff = this.raw.el;
        }
        this.fx.reset();
        this.fy.reset();
        this.cur = null;
        this.last = null;
        this.history = [];
        return;
      case 'pause':
        this.paused = input.on;
        if (input.on && this.downAt !== null) {
          this.sink.up(0);
          this.downAt = null;
        }
        this.last = null;
        return;
      case 'invert':
        if (input.el !== undefined) this.motion.invertEl = input.el;
        if (input.az !== undefined) this.motion.invertAz = input.az;
        return;
      case 'down':
        if (this.paused) return;
        this.onDown(input.t);
        return;
      case 'up':
        if (this.downAt === null) return;
        this.sink.up(Math.max(0, input.t - this.downAt));
        this.downAt = null;
        return;
      case 'right':
        if (!this.paused) this.sink.right();
        return;
      case 'scroll':
        if (!this.paused && Number.isFinite(input.dy)) this.sink.scroll(input.dy);
        return;
    }
  }

  /** Suelta lo que esté pulsado (al cerrarse la conexión). */
  stop(): void {
    if (this.downAt !== null) {
      this.sink.up(0);
      this.downAt = null;
    }
  }

  private onMotion(s: MotionSample & { k: 'm' }): void {
    const a = this.motion.process(s);
    if (!a) return;
    this.raw = a;
    this.lastT = s.t;
    if (this.paused) return;
    const xDeg = -(a.az - this.azOff);
    const yDeg = -(a.el - this.elOff);
    const p = this.project(xDeg, yDeg);
    const f = { x: this.fx.filter(p.x, s.t), y: this.fy.filter(p.y, s.t) };
    this.history.push({ t: s.t, ...f });
    while (this.history.length > 0 && s.t - (this.history[0]?.t ?? s.t) > 1) this.history.shift();
    if (s.t < this.freezeUntil) return;
    this.place(f);
  }

  private place(f: { x: number; y: number }): void {
    this.cur = f;
    if (this.sink.absolute) {
      this.sink.moveTo?.(Math.round(f.x), Math.round(f.y));
      return;
    }
    if (this.last) this.sink.moveBy?.(f.x - this.last.x, f.y - this.last.y, this.downAt !== null);
    this.last = f;
  }

  private pointAt(t: number): { x: number; y: number } | null {
    let best: { t: number; x: number; y: number } | undefined;
    for (const h of this.history) {
      if (h.t <= t) best = h;
      else break;
    }
    return best ?? this.cur;
  }

  private onDown(t: number): void {
    // Con el toque, el móvil se sacude: el clic va a donde apuntabas un instante antes.
    const p = this.pointAt(t - CLICK_LOOKBACK_S);
    if (p) this.place(p);
    this.freezeUntil = Math.max(t, this.lastT) + CLICK_FREEZE_S;
    this.downAt = t;
    this.sink.down();
  }
}
