import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';

/**
 * /stop pulsado MIENTRAS la tele abre la nota (conectar con la tele puede tardar
 * segundos): la nota no puede quedarse sonando en la tele sin que /stop la encuentre.
 */
const note = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });

function setup(opts: { castStop?: boolean } = {}) {
  let finishCast: () => void = () => {};
  const castStop = vi.fn(async () => true);
  const stopTv = vi.fn(async () => true);
  const close = vi.fn();
  const castToTv = vi.fn(
    () =>
      new Promise<{
        ok: boolean;
        message: string;
        stop?: () => Promise<unknown>;
        close?: () => void;
      }>((resolve) => {
        finishCast = () =>
          resolve({
            ok: true,
            message: 'ok',
            ...(opts.castStop === false ? {} : { stop: castStop }),
            close,
          });
      }),
  );
  const p = createAltavozPlayer({
    toPlayable: async () => '/tmp/fake.mp3',
    playOnPc: async () => {},
    castToTv,
    stopTv,
    remove: () => {},
  });
  return { p, castToTv, castStop, stopTv, close, finish: () => finishCast() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('/stop mientras la tele abre la nota', () => {
  it('para la nota con el «parar» del propio cast y cierra el servidor del audio', async () => {
    const t = setup();
    t.p.enqueue('tele', note, undefined, 'chat:A');
    await vi.waitFor(() => expect(t.castToTv).toHaveBeenCalledTimes(1));
    expect(t.p.clear('chat:A')).toBe(1);
    t.finish();
    await t.p.idle();
    await tick();
    expect(t.castStop).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledTimes(1);
    // Ya parada: un segundo /stop no vuelve a mandar nada a la tele.
    t.p.clear('chat:A');
    await tick();
    expect(t.castStop).toHaveBeenCalledTimes(1);
  });

  it('sin «parar» propio usa el genérico de la tele', async () => {
    const t = setup({ castStop: false });
    t.p.enqueue('tele', note, undefined, 'chat:A');
    await vi.waitFor(() => expect(t.castToTv).toHaveBeenCalledTimes(1));
    t.p.clear('chat:A');
    t.finish();
    await t.p.idle();
    await tick();
    expect(t.stopTv).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it('el /stop de otro chat no para la nota', async () => {
    const t = setup();
    t.p.enqueue('tele', note, undefined, 'chat:A');
    await vi.waitFor(() => expect(t.castToTv).toHaveBeenCalledTimes(1));
    expect(t.p.clear('chat:B')).toBe(0);
    t.finish();
    await t.p.idle();
    await tick();
    expect(t.castStop).not.toHaveBeenCalled();
    expect(t.close).not.toHaveBeenCalled();
    // Y sigue siendo parable por su chat.
    expect(t.p.clear('chat:A')).toBe(1);
    await tick();
    expect(t.castStop).toHaveBeenCalledTimes(1);
  });
});
