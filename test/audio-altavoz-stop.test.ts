import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer, stopReplyText } from '../src/audio/altavoz.js';

const bytes = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });

describe('/stop vacía el altavoz', () => {
  it('corta la nota que suena, descarta la cola de ese chat y no avisa de fallo', async () => {
    const played: string[] = [];
    const removed: string[] = [];
    let n = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => {
      started = r;
    });
    const p = createAltavozPlayer({
      toPlayable: async () => `n${++n}.mp3`,
      playOnPc: (f, signal) =>
        new Promise<void>((resolve) => {
          played.push(f);
          if (f === 'n1.mp3') started();
          // Una nota «larga»: solo acaba si la cortan.
          signal?.addEventListener('abort', () => resolve(), { once: true });
          if (f !== 'n1.mp3') resolve();
        }),
      remove: (f) => removed.push(f),
    });
    const onFail = vi.fn();
    p.enqueue('pc', bytes, onFail, 'tg:1');
    p.enqueue('pc', bytes, onFail, 'tg:1');
    p.enqueue('pc', bytes, onFail, 'tg:1');
    await firstStarted;
    expect(p.clear('tg:1')).toBe(3);
    await p.idle();
    expect(played).toEqual(['n1.mp3']);
    expect(removed).toEqual(['n1.mp3']);
    expect(onFail).not.toHaveBeenCalled();
    expect(p.pending()).toBe(0);
    // La cola sigue viva: la siguiente nota suena normal.
    p.enqueue('pc', bytes, onFail, 'tg:1');
    await p.idle();
    expect(played).toEqual(['n1.mp3', 'n2.mp3']);
  });

  it('un error al cortarla tampoco cuenta como fallo', async () => {
    const onFail = vi.fn();
    const onError = vi.fn();
    let started!: () => void;
    const go = new Promise<void>((r) => {
      started = r;
    });
    const p = createAltavozPlayer({
      toPlayable: async () => 'a.mp3',
      playOnPc: (_f, signal) =>
        new Promise<void>((_res, rej) => {
          started();
          signal?.addEventListener('abort', () => rej(new Error('MCI cerrado')), { once: true });
        }),
      remove: () => {},
      onError,
    });
    p.enqueue('pc', bytes, onFail, 'tg:1');
    await go;
    p.clear('tg:1');
    await p.idle();
    expect(onFail).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('solo para las notas de su chat', async () => {
    const played: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p = createAltavozPlayer({
      toPlayable: async (b) => `${b.toString()}.mp3`,
      playOnPc: async (f) => {
        played.push(f);
        if (f === 'a.mp3') await gate;
      },
      remove: () => {},
    });
    const note = (s: string) => async () => ({ bytes: Buffer.from(s), mimeType: 'audio/ogg' });
    p.enqueue('pc', note('a'), undefined, 'tg:otro');
    p.enqueue('pc', note('b'), undefined, 'tg:1');
    p.enqueue('pc', note('c'), undefined, 'tg:otro');
    expect(p.clear('tg:1')).toBe(1);
    release();
    await p.idle();
    expect(played).toEqual(['a.mp3', 'c.mp3']);
  });

  it('sin nada en cola, clear devuelve 0', () => {
    const p = createAltavozPlayer({
      toPlayable: async () => 'x',
      playOnPc: async () => {},
      remove: () => {},
    });
    expect(p.clear('tg:1')).toBe(0);
    expect(p.clear()).toBe(0);
  });

  it('texto de /stop', () => {
    expect(stopReplyText(0, 0)).toBe('No había nada en curso.');
    expect(stopReplyText(2, 0)).toBe('Detenido. 2 conversación(es) abortadas y la cola limpia.');
    expect(stopReplyText(0, 1)).toBe('Detenido. 1 nota(s) de voz paradas en el altavoz.');
    expect(stopReplyText(1, 3)).toContain('; 3 nota(s)');
  });
});
