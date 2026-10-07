import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ answers: [] as Array<string | Error>, calls: [] as string[] }));
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, out: string, err: string) => void,
  ) => {
    mock.calls.push(args.at(-1) ?? '');
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

import { getVolume, playAudioFile, playbackRestoreText } from '../src/tools/system.js';

beforeEach(() => {
  mock.answers = [];
  mock.calls = [];
});
it('zero starting volume plus failed restore process and failed read is failed, never restored', async () => {
  mock.answers = [
    '1',
    '0|1',
    'set hr=0',
    '100|0',
    'played 3',
    new Error('restore crashed'),
    new Error('read crashed'),
  ];
  const r = await playAudioFile('a.wav');
  expect(r.restoreStatus).toBe('failed');
  expect(r.volumeRestoredTo).toBeNull();
  expect(playbackRestoreText(r)).toContain('Puede seguir alto');
});
it('nonzero mismatch is failed', async () => {
  mock.answers = ['1', '35|0', 'set hr=0', '100|0', 'played 3', 'set hr=0', '100|0'];
  expect((await playAudioFile('a.wav')).restoreStatus).toBe('failed');
});
it('verified zero restore is real', async () => {
  mock.answers = ['1', '0|1', 'set hr=0', '100|0', 'played 3', 'set hr=0', '0|1'];
  const r = await playAudioFile('a.wav');
  expect(r.restoreStatus).toBe('restored');
  expect(r.volumeRestoredTo).toBe(0);
});
it('not requested never invokes restore', async () => {
  mock.answers = ['1', '35|0', 'set hr=0', '100|0', 'played 3'];
  expect((await playAudioFile('a.wav', { restoreVolume: false })).restoreStatus).toBe(
    'not-requested',
  );
  expect(mock.answers).toHaveLength(0);
});
it.each(['', 'junk', '100|x', '101|0', '-1|0'])('invalid read %j is not zero', async (out) => {
  mock.answers = [out];
  await expect(getVolume()).rejects.toThrow();
});

it('successful restore write but failed read cannot certify zero restoration', async () => {
  mock.answers = [
    '1',
    '0|1',
    'set hr=0',
    '100|0',
    'played 3',
    'set hr=0',
    new Error('read crashed'),
  ];
  const r = await playAudioFile('a.wav');
  expect(r.restoreStatus).toBe('failed');
  expect(r.volumeRestoredTo).toBeNull();
});
it('initial read process failure does not become zero', async () => {
  mock.answers = [new Error('read crashed')];
  await expect(getVolume()).rejects.toThrow('read crashed');
});
