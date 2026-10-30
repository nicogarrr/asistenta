import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import { tvStopperFromVault } from '../src/audio/tv-cast.js';

/**
 * /stop con /altavoz tele: la tele se queda con la nota y sigue sonando aunque la cola
 * ya terminó. /stop la para solo si ese chat mandó algo a la tele hace poco (2 min).
 */
const note = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });

function setup(opts: { stopTv?: boolean } = {}) {
  let t = 1_000_000;
  const stopTv = vi.fn(async () => true);
  const p = createAltavozPlayer({
    toPlayable: async () => '/tmp/fake.mp3',
    playOnPc: async () => {},
    castToTv: async () => ({ ok: true, message: 'ok', hits: () => 1 }),
    stopTv: opts.stopTv === false ? undefined : stopTv,
    remove: () => {},
    now: () => t,
  });
  return {
    p,
    stopTv,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('/stop en modo tele', () => {
  it('para en la tele la nota que ese chat mandó hace poco y la cuenta', async () => {
    const { p, stopTv, advance } = setup();
    p.enqueue('tele', note, undefined, 'chat:A');
    await p.idle();
    advance(30_000);
    expect(p.clear('chat:A')).toBe(1);
    expect(stopTv).toHaveBeenCalledTimes(1);
  });

  it('pasados 2 minutos no toca la tele', async () => {
    const { p, stopTv, advance } = setup();
    p.enqueue('tele', note, undefined, 'chat:A');
    await p.idle();
    advance(121_000);
    expect(p.clear('chat:A')).toBe(0);
    expect(stopTv).not.toHaveBeenCalled();
  });

  it('el /stop de otro chat no para la tele', async () => {
    const { p, stopTv } = setup();
    p.enqueue('tele', note, undefined, 'chat:A');
    await p.idle();
    expect(p.clear('chat:B')).toBe(0);
    expect(stopTv).not.toHaveBeenCalled();
  });

  it('un segundo /stop no vuelve a mandar la orden', async () => {
    const { p, stopTv } = setup();
    p.enqueue('tele', note, undefined, 'chat:A');
    await p.idle();
    p.clear('chat:A');
    expect(p.clear('chat:A')).toBe(0);
    expect(stopTv).toHaveBeenCalledTimes(1);
  });

  it('en modo PC, o sin nada mandado a la tele, la tele no se toca', async () => {
    const { p, stopTv } = setup();
    expect(p.clear('chat:A')).toBe(0);
    p.enqueue('pc', note, undefined, 'chat:A');
    await p.idle();
    expect(p.clear('chat:A')).toBe(0);
    expect(stopTv).not.toHaveBeenCalled();
  });

  it('si la orden a la tele falla, /stop no se rompe', async () => {
    const onError = vi.fn();
    const p = createAltavozPlayer({
      toPlayable: async () => '/tmp/fake.mp3',
      playOnPc: async () => {},
      castToTv: async () => ({ ok: true, message: 'ok' }),
      stopTv: async () => {
        throw new Error('la tele no responde');
      },
      remove: () => {},
      onError,
    });
    p.enqueue('tele', note, undefined, 'chat:A');
    await p.idle();
    expect(p.clear('chat:A')).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('tvStopperFromVault', () => {
  it('manda media.controls/stop a la tele emparejada', async () => {
    const vault: Record<string, string> = { 'tv:host': '192.168.1.50', 'tv:clientKey': 'k' };
    const request = vi.fn(async () => ({}));
    const ok = await tvStopperFromVault(async (k) => vault[k], request)();
    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      '192.168.1.50',
      'k',
      'media.controls/stop',
      {},
      {
        allowPlaintext: false,
      },
    );
  });

  it('sin emparejar no hace nada', async () => {
    const request = vi.fn(async () => ({}));
    expect(await tvStopperFromVault(async () => undefined, request)()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
