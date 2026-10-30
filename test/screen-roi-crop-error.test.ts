import { beforeEach, describe, expect, it, vi } from 'vitest';

// The crop runs through execFile; the mock plays a failed PowerShell call.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

import { captureRoi } from '../src/screen/verify.js';

const SCRIPT_MARK = 'Add-Type -AssemblyName System.Drawing';

function shot() {
  return {
    image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    mimeType: 'image/jpeg' as const,
    width: 100,
    height: 100,
    nativeWidth: 200,
    nativeHeight: 200,
  };
}

function failWith(extra: Record<string, unknown>) {
  execFileMock.mockImplementation((...a: unknown[]) => {
    const cb = a.findLast((x) => typeof x === 'function') as ((e: unknown) => void) | undefined;
    if (!cb) return undefined;
    const args = (Array.isArray(a[1]) ? a[1] : []) as string[];
    const err = Object.assign(
      new Error(
        `Command failed: powershell.exe -NoProfile -NonInteractive -Command ${args.at(-1)}`,
      ),
      extra,
    );
    cb(err);
  });
}

describe('captureRoi crop failure detail', () => {
  beforeEach(() => execFileMock.mockReset());

  it("keeps PowerShell's own sentence and drops the generated script", async () => {
    failWith({
      code: 1,
      stderr:
        'Exception calling "FromFile" with "1" argument(s): "Out of memory."\r\nAt line:4 char:1\r\n+ $src = [System.Drawing.Image]::FromFile(\'C:\\x\\in.jpg\')\r\n',
    });
    const r = await captureRoi(
      { screenshot: async () => shot() },
      { x: 10, y: 10, width: 20, height: 20 },
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(r.width).toBe(100); // degraded to the full capture
    expect(r.detail).toContain('Out of memory.');
    expect(r.detail).toContain('va la captura completa');
    expect(r.detail).not.toContain('Command failed');
    expect(r.detail).not.toContain(SCRIPT_MARK);
    expect(r.detail).not.toContain("FromFile('");
    expect((r.detail ?? '').length).toBeLessThan(500);
  });

  it("says plainly when the crop timed out, with the crop's own 20 s", async () => {
    failWith({ killed: true, signal: 'SIGTERM', code: null, stderr: '' });
    const r = await captureRoi(
      { screenshot: async () => shot() },
      { x: 0, y: 0, width: 50, height: 50 },
    );
    expect(r.detail).toContain('no respondió en 20 s');
    expect(r.detail).not.toContain(SCRIPT_MARK);
  });
});
