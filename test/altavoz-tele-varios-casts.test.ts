import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';

// Dos «reprodúcelo en la tele» seguidos en el mismo chat: /stop debe usar el «parar» de
// los dos casts (cada uno cierra su propio servidor LAN), no solo el del último.
describe('AltavozPlayer: varios casts a la tele en el mismo chat', () => {
  const make = (now: () => number) => {
    const stopTv = vi.fn(async () => {});
    const p = createAltavozPlayer({
      toPlayable: async () => 'x',
      playOnPc: async () => {},
      stopTv,
      now,
      remove: () => {},
    });
    return { p, stopTv };
  };

  it('/stop llama al «parar» de los dos casts de la ventana', () => {
    let t = 1_000;
    const { p, stopTv } = make(() => t);
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    p.noteTele('telegram:a:1', first);
    t += 30_000;
    p.noteTele('telegram:a:1', second);
    expect(p.clear('telegram:a:1')).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(stopTv).not.toHaveBeenCalled();
    // ya parados: otro /stop no vuelve a tocar la tele
    expect(p.clear('telegram:a:1')).toBe(0);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('un cast con «parar» propio y otro sin él: llama al propio y al genérico', () => {
    let t = 1_000;
    const { p, stopTv } = make(() => t);
    const own = vi.fn(async () => {});
    p.noteTele('telegram:a:1', own);
    t += 1_000;
    p.noteTele('telegram:a:1');
    expect(p.clear('telegram:a:1')).toBe(1);
    expect(own).toHaveBeenCalledTimes(1);
    expect(stopTv).toHaveBeenCalledTimes(1);
  });

  it('el cast que ya salió de la ventana de 2 min no se toca; el reciente sí', () => {
    let t = 1_000;
    const { p } = make(() => t);
    const old = vi.fn(async () => {});
    const recent = vi.fn(async () => {});
    p.noteTele('telegram:a:1', old);
    t += 100_000;
    p.noteTele('telegram:a:1', recent);
    t += 30_000; // el primero tiene 130 s, el segundo 30 s
    expect(p.clear('telegram:a:1')).toBe(1);
    expect(old).not.toHaveBeenCalled();
    expect(recent).toHaveBeenCalledTimes(1);
  });

  it('/stop de otro chat no toca los casts de este', () => {
    const { p, stopTv } = make(() => 1_000);
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    p.noteTele('telegram:a:1', a);
    p.noteTele('telegram:a:1', b);
    expect(p.clear('telegram:a:2')).toBe(0);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(stopTv).not.toHaveBeenCalled();
  });
});
