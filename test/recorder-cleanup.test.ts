import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A screen recording is a video of Nico's desktop. When ffmpeg fails or times out
// half way, the partial file must not stay behind in the voice folder.
const dir = mkdtempSync(join(tmpdir(), 'pa-rec-cleanup-'));
let mode: 'fail' | 'ok' = 'fail';

vi.mock('ffmpeg-static', () => ({ default: process.execPath }));
vi.mock('../src/paths.js', async (orig) => {
  const real = (await orig()) as { paths: Record<string, string> };
  return {
    ...real,
    paths: new Proxy(real.paths, { get: (t, k) => (k === 'voice' ? dir : Reflect.get(t, k)) }),
  };
});
vi.mock('node:child_process', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    spawn: (_exe: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      const out = args[args.length - 1] ?? '';
      setImmediate(() => {
        if (args.includes('gdigrab')) {
          writeFileSync(out, 'partial video bytes');
          if (mode === 'fail') child.stderr.emit('data', Buffer.from('boom'));
          child.emit('close', mode === 'fail' ? 1 : 0);
        } else {
          child.stderr.emit('data', Buffer.from('Video: h264, yuv420p, 640x360'));
          child.emit('close', 1);
        }
      });
      return child;
    },
  };
});

const { recordScreen } = await import('../src/screen/recorder.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('recordScreen cleanup', () => {
  it('deletes the partial recording when ffmpeg fails', async () => {
    mode = 'fail';
    await expect(recordScreen({ seconds: 1 })).rejects.toThrow(/ffmpeg salio con 1/);
    expect(readdirSync(dir).filter((f) => f.startsWith('rec-'))).toEqual([]);
  });

  it('keeps the file when the recording succeeds (characterization)', async () => {
    mode = 'ok';
    const rec = await recordScreen({ seconds: 1 });
    expect(existsSync(rec.file)).toBe(true);
    expect(rec.width).toBe(640);
    rmSync(rec.file, { force: true });
  });
});
