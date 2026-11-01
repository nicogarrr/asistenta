import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';

// /stop sobre una nota que ya suena en la tele: además de pararla, cierra el servidor
// LAN que le sirve el audio (y borra la copia). Antes quedaba abierto hasta su ventana.
describe('/stop cierra el servidor del audio de la tele', () => {
  const make = (extra: Record<string, unknown> = {}) => {
    const stopTv = vi.fn(async () => {});
    const p = createAltavozPlayer({
      toPlayable: async () => 'x',
      playOnPc: async () => {},
      stopTv,
      remove: () => {},
      ...extra,
    });
    return { p, stopTv };
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('reprodúcelo en la tele: /stop para y después cierra el servidor', async () => {
    const { p } = make();
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push('stop');
    });
    const close = vi.fn(() => {
      order.push('close');
    });
    p.noteTele('telegram:a:1', stop, close);
    expect(p.clear('telegram:a:1')).toBe(1);
    await tick();
    expect(order).toEqual(['stop', 'close']);
  });

  it('si la tele no contesta bien al parar, el servidor se cierra igual', async () => {
    const onError = vi.fn();
    const { p } = make({ onError });
    const stop = vi.fn(async () => {
      throw new Error('tele apagada');
    });
    const close = vi.fn();
    p.noteTele('telegram:a:1', stop, close);
    p.clear('telegram:a:1');
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });

  it('/altavoz tele: /stop cierra el servidor de la nota que ya sonaba', async () => {
    const close = vi.fn();
    const stop = vi.fn(async () => {});
    const castToTv = vi.fn(async () => ({ ok: true, message: 'ok', stop, close, hits: () => 1 }));
    const { p } = make({ castToTv });
    p.enqueue(
      'tele',
      async () => ({ bytes: Buffer.from('a'), mimeType: 'audio/ogg' }),
      undefined,
      'telegram:a:1',
    );
    await p.idle();
    expect(close).not.toHaveBeenCalled();
    expect(p.clear('telegram:a:1')).toBe(1);
    await tick();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('un /stop de otro chat no cierra nada', async () => {
    const { p } = make();
    const close = vi.fn();
    p.noteTele(
      'telegram:a:1',
      vi.fn(async () => {}),
      close,
    );
    expect(p.clear('telegram:b:2')).toBe(0);
    await tick();
    expect(close).not.toHaveBeenCalled();
  });
});
