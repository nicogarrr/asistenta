import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  answers: [] as Array<string | Error>,
  calls: [] as string[],
  hangPlay: false,
  playing: undefined as undefined | (() => void),
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    opts: { signal?: AbortSignal },
    cb: (error: Error | null, out: string, err: string) => void,
  ) => {
    mock.calls.push(args.at(-1) ?? '');
    if ((args.at(-1) ?? '').includes('PaMci') && mock.hangPlay) {
      // Reproduciendo: solo acaba si alguien aborta (como execFile con `signal`).
      mock.playing?.();
      opts.signal?.addEventListener(
        'abort',
        () =>
          cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), '', ''),
        { once: true },
      );
      return;
    }
    const answer = mock.answers.shift();
    if (answer instanceof Error) cb(answer, '', '');
    else if (answer === undefined) cb(new Error('unexpected process'), '', '');
    else cb(null, answer, '');
  },
}));
vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) =>
          fn(...args, (err: Error | null, out: string) =>
            err ? reject(err) : resolve({ stdout: out }),
          ),
        ),
  };
});

import { playAudioFile } from '../src/tools/system.js';

beforeEach(() => {
  mock.answers = [];
  mock.calls = [];
  mock.hangPlay = false;
  mock.playing = undefined;
});

it('/stop durante la reproducción en el PC: corta el sonido y restaura el volumen', async () => {
  // Test-Path, volumen inicial 35, poner 100, verificar; (reproducción colgada); restaurar 35.
  mock.answers = ['1', '35|0', 'set hr=0', '100|0', 'set hr=0', '35|0'];
  mock.hangPlay = true;
  const ac = new AbortController();
  mock.playing = () => setTimeout(() => ac.abort(), 0);
  const r = await playAudioFile('a.mp3', { volume: 100, signal: ac.signal });
  expect(r.ok).toBe(false);
  expect(r.detail).toContain('/stop');
  expect(r.restoreStatus).toBe('restored');
  expect(r.volumeRestoredTo).toBe(35);
});

it('/stop antes de empezar: no toca el volumen ni lanza nada', async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await playAudioFile('a.mp3', { volume: 100, signal: ac.signal });
  expect(r.ok).toBe(false);
  expect(mock.calls).toHaveLength(0);
  expect(r.restoreStatus).toBe('not-requested');
});

it('sin /stop la reproducción sigue igual', async () => {
  mock.answers = ['1', '35|0', 'set hr=0', '100|0', 'played 3', 'set hr=0', '35|0'];
  const r = await playAudioFile('a.mp3', { volume: 100, signal: new AbortController().signal });
  expect(r.ok).toBe(true);
  expect(r.seconds).toBe(3);
});
