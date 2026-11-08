import { describe, expect, it } from 'vitest';
import { AimEngine, type AimSink, CLICK_LOOKBACK_S } from '../src/aim/engine.js';
import { MotionAim } from '../src/aim/motion.js';
import { OneEuro } from '../src/aim/oneeuro.js';

describe('OneEuro', () => {
  it('la primera muestra pasa tal cual y reset olvida', () => {
    const f = new OneEuro(1, 0);
    expect(f.filter(10, 0)).toBe(10);
    f.filter(20, 0.01);
    f.reset();
    expect(f.filter(5, 1)).toBe(5);
  });
  it('suaviza un salto pequeño y sigue rápido uno grande (beta)', () => {
    const lento = new OneEuro(1, 0);
    const rapido = new OneEuro(1, 5);
    lento.filter(0, 0);
    rapido.filter(0, 0);
    let l = 0;
    let r = 0;
    for (let i = 1; i <= 10; i++) {
      l = lento.filter(100, i * 0.01);
      r = rapido.filter(100, i * 0.01);
    }
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThan(100);
    expect(r).toBeGreaterThan(l);
  });
});

// Reacción a la gravedad como la mide el móvil: tumbado boca arriba z ≈ +9,8; con el borde de
// arriba levantado `tiltUpDeg` grados, y = 9,8·sen y z = 9,8·cos.
const upright = (tiltUpDeg = 0): [number, number, number] => {
  const a = (tiltUpDeg * Math.PI) / 180;
  return [0, 9.8 * Math.sin(a), 9.8 * Math.cos(a)];
};

describe('MotionAim', () => {
  it('tumbado como un mando el borde de arriba mira al horizonte (el = 0); levantado, el > 0; de pie, 90', () => {
    const m = new MotionAim();
    expect(m.process({ t: 0, g: upright(0), r: [0, 0, 0] })?.el).toBeCloseTo(0, 5);
    const up = m.process({ t: 0.01, g: upright(30), r: [0, 0, 0] });
    expect(up?.el).toBeCloseTo(30, 3);
    const down = m.process({ t: 0.02, g: upright(-30), r: [0, 0, 0] });
    expect(down?.el).toBeCloseTo(-30, 3);
    expect(m.process({ t: 0.03, g: [0, 9.8, 0], r: [0, 0, 0] })?.el).toBeCloseTo(90, 3);
  });
  it('invertEl cambia el signo de arriba/abajo', () => {
    const m = new MotionAim();
    m.invertEl = true;
    expect(m.process({ t: 0, g: upright(30), r: [0, 0, 0] })?.el).toBeCloseTo(-30, 3);
  });
  it('el azimut suma el giro alrededor de la vertical (alpha, z del móvil, con el móvil tumbado)', () => {
    const m = new MotionAim();
    // Tumbado, la vertical real es el eje z del móvil: el giro sale de alpha (r[2]).
    m.process({ t: 0, g: upright(0), r: [0, 0, 0] });
    let az = 0;
    for (let i = 1; i <= 10; i++)
      az = m.process({ t: i * 0.01, g: upright(0), r: [0, 0, 50] })?.az ?? 0;
    expect(Math.abs(az)).toBeCloseTo(5, 3); // 50 °/s durante 0,1 s
    const inv = new MotionAim();
    inv.invertAz = true;
    inv.process({ t: 0, g: upright(0), r: [0, 0, 0] });
    let az2 = 0;
    for (let i = 1; i <= 10; i++)
      az2 = inv.process({ t: i * 0.01, g: upright(0), r: [0, 0, 50] })?.az ?? 0;
    expect(az2).toBeCloseTo(-az, 5);
  });
  it('sin gravedad válida no devuelve nada', () => {
    expect(new MotionAim().process({ t: 0, g: [0, 0, 0], r: [0, 0, 0] })).toBeNull();
  });
});

function fakeSink(absolute: boolean) {
  const calls: string[] = [];
  const sink: AimSink = {
    screen: { w: 1920, h: 1080 },
    absolute,
    moveTo: (x, y) => calls.push(`M ${x} ${y}`),
    moveBy: (dx, dy, d) => calls.push(`B ${dx.toFixed(1)} ${dy.toFixed(1)} ${d}`),
    down: () => calls.push('D'),
    up: (h) => calls.push(`U ${h.toFixed(2)}`),
    right: () => calls.push('R'),
    scroll: (dy) => calls.push(`S ${dy}`),
  };
  return { sink, calls };
}

const m = (t: number, tiltUp = 0, yaw = 0) => ({
  k: 'm' as const,
  t,
  g: upright(tiltUp),
  r: [0, 0, yaw] as [number, number, number],
});

describe('AimEngine', () => {
  it('Centrar pone el cursor en el centro de la pantalla', () => {
    const { sink, calls } = fakeSink(true);
    const e = new AimEngine(sink);
    e.handle(m(0, 12));
    e.handle({ k: 'center' });
    e.handle(m(0.01, 12));
    expect(calls.at(-1)).toBe('M 960 540');
  });
  it('inclinar hacia arriba sube el cursor (y menor) y hacia abajo lo baja', () => {
    const { sink, calls } = fakeSink(true);
    const e = new AimEngine(sink);
    e.handle(m(0));
    e.handle({ k: 'center' });
    e.handle(m(0.01, 10));
    const y = Number(calls.at(-1)?.split(' ')[2]);
    expect(y).toBeLessThan(540);
    e.handle({ k: 'center' });
    e.handle(m(1, -10));
    const y2 = Number(calls.at(-1)?.split(' ')[2]);
    expect(y2).toBeGreaterThan(540);
  });
  it('no se sale de la pantalla aunque se apunte muy lejos', () => {
    const { sink, calls } = fakeSink(true);
    const e = new AimEngine(sink);
    e.handle(m(0));
    e.handle({ k: 'center' });
    e.handle(m(0.01, 80));
    const [, x, y] = calls.at(-1)?.split(' ') ?? [];
    expect(Number(y)).toBeGreaterThanOrEqual(0);
    expect(Number(x)).toBeLessThan(1920);
  });
  it('con puntero relativo manda deltas, y arrastra con down:true mientras se mantiene', () => {
    const { sink, calls } = fakeSink(false);
    const e = new AimEngine(sink);
    e.handle(m(0));
    e.handle({ k: 'center' });
    e.handle(m(1, 0));
    e.handle(m(1.5, 5));
    expect(calls.some((c) => c.startsWith('B ') && c.endsWith('false'))).toBe(true);
    e.handle({ k: 'down', t: 2 });
    e.handle(m(2.5, 8));
    expect(calls.some((c) => c.startsWith('B ') && c.endsWith('true'))).toBe(true);
  });
  it('el clic va a donde se apuntaba justo antes del toque y congela el cursor un momento', () => {
    const { sink, calls } = fakeSink(true);
    const e = new AimEngine(sink);
    e.handle(m(0));
    e.handle({ k: 'center' });
    e.handle(m(1.0, 0));
    const antes = calls.at(-1);
    e.handle(m(1.05, 0));
    e.handle(m(1.09, 20)); // sacudida del toque (dentro de CLICK_LOOKBACK_S)
    expect(CLICK_LOOKBACK_S).toBe(0.1);
    e.handle({ k: 'down', t: 1.1 });
    const i = calls.lastIndexOf('D');
    expect(calls[i - 1]).toBe(antes); // se recoloca al punto de antes, no al sacudido
    const n = calls.length;
    e.handle(m(1.15, 20)); // todavía congelado
    expect(calls.length).toBe(n);
    e.handle(m(1.3, 20)); // descongela
    expect(calls.length).toBe(n + 1);
    e.handle({ k: 'up', t: 1.35 });
    expect(calls.at(-1)).toBe('U 0.25');
  });
  it('pausa suelta lo pulsado e ignora clics; stop también suelta', () => {
    const { sink, calls } = fakeSink(true);
    const e = new AimEngine(sink);
    e.handle(m(0));
    e.handle({ k: 'down', t: 1 });
    e.handle({ k: 'pause', on: true });
    expect(calls.at(-1)).toBe('U 0.00');
    const n = calls.length;
    e.handle({ k: 'down', t: 2 });
    e.handle({ k: 'right' });
    e.handle({ k: 'scroll', dy: 5 });
    expect(calls.length).toBe(n);
    e.handle({ k: 'pause', on: false });
    e.handle({ k: 'down', t: 3 });
    e.stop();
    expect(calls.at(-1)).toBe('U 0.00');
  });
  it('clic derecho y scroll llegan al destino', () => {
    const { sink, calls } = fakeSink(true);
    const e = new AimEngine(sink);
    e.handle({ k: 'right' });
    e.handle({ k: 'scroll', dy: -7 });
    expect(calls).toEqual(['R', 'S -7']);
  });
});
