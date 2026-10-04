import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import {
  clipRegion,
  expand,
  type Region,
  regionContains,
  regionsOverlap,
  scaleRegion,
} from '../src/screen/regions.js';
import type { Screenshot } from '../src/screen/verify.js';
import { verifyBatch } from '../src/screen/verify.js';
import type {
  ActionGate,
  BatchItemResult,
  ScreenBackend,
  ScreenShot,
} from '../src/tools/computer.js';
import { createComputerTool } from '../src/tools/computer.js';
import { isWindows } from './helpers/platform.js';

const execFileAsync = promisify(execFile);

/**
 * Batch computer use, region maths and batch verification.
 *
 * Everything here is synthetic on purpose: the geometry is pure arithmetic, the
 * batch runs against a mocked backend (a real one would move this machine's
 * mouse mid-test), and the two `verifyBatch` cases compare painted frames
 * through the same path a screenshot takes — which is what caught the earlier
 * "idle screen reads as changed" bug. No real screen is ever captured.
 */

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'test',
    model: 'test',
    baseUrl: 'http://localhost',
    toolTimeoutMs: 5_000,
    runTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    screenshotMaxEdge: 1280,
    screenshotQuality: 80,
    verifyActions: false,
    verifySettleMs: 1,
    cron: [],
    retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    maxToolCalls: 10,
    downloadCookiesBrowser: '',
    curlImpersonatePath: '',
    browserChannel: 'chrome',
    ...overrides,
  };
}

function fakeBackend(opts: { failOnType?: string } = {}): {
  backend: ScreenBackend;
  calls: string[];
} {
  const calls: string[] = [];
  const shot = (): ScreenShot => ({
    image: Buffer.from('frame'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
    nativeWidth: 1920,
    nativeHeight: 1080,
  });
  const backend: ScreenBackend = {
    screenshot: async () => {
      calls.push('screenshot');
      return shot();
    },
    click: async (x, y) => {
      calls.push(`click:${x},${y}`);
    },
    move: async (x, y) => {
      calls.push(`move:${x},${y}`);
    },
    drag: async (x, y, toX, toY) => {
      calls.push(`drag:${x},${y}->${toX},${toY}`);
    },
    type: async (text) => {
      calls.push(`type:${text}`);
      if (opts.failOnType === text) throw new Error('type failed');
    },
    key: async (key) => {
      calls.push(`key:${key}`);
    },
    screenSize: async () => ({ width: 1920, height: 1080 }),
  };
  return { backend, calls };
}

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });

function batchResults(details: unknown): BatchItemResult[] {
  const shaped = details as { results?: unknown };
  if (!Array.isArray(shaped.results)) throw new Error('batch details missing results');
  return shaped.results as BatchItemResult[];
}

describe('region geometry', () => {
  it('clips to bounds and returns null when nothing is left', () => {
    const bounds: Region = { x: 0, y: 0, width: 100, height: 100 };
    expect(clipRegion({ x: 10, y: 10, width: 50, height: 50 }, bounds)).toEqual({
      x: 10,
      y: 10,
      width: 50,
      height: 50,
    });
    // Half off the left edge: the visible part only.
    expect(clipRegion({ x: -30, y: 10, width: 50, height: 50 }, bounds)).toEqual({
      x: 0,
      y: 10,
      width: 20,
      height: 50,
    });
    // Completely off screen.
    expect(clipRegion({ x: 500, y: 500, width: 10, height: 10 }, bounds)).toBeNull();
  });

  it('treats a degenerate region as empty', () => {
    const bounds: Region = { x: 0, y: 0, width: 100, height: 100 };
    expect(clipRegion({ x: 5, y: 5, width: 0, height: 10 }, bounds)).toBeNull();
    // Negative size is not "backwards", it is empty: no area to crop.
    expect(clipRegion({ x: 5, y: 5, width: -10, height: 10 }, bounds)).toBeNull();
  });

  it('scales regions proportionally between coordinate spaces', () => {
    // The exact translation a 1280x720 screenshot needs onto a 1920x1080 desktop.
    expect(
      scaleRegion(
        { x: 100, y: 50, width: 200, height: 100 },
        { x: 0, y: 0, width: 1280, height: 720 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 150, y: 75, width: 300, height: 150 });
    // Offsets are honoured: the region at `from`'s origin lands at `to`'s origin.
    expect(
      scaleRegion(
        { x: 100, y: 100, width: 200, height: 200 },
        { x: 100, y: 100, width: 200, height: 200 },
        { x: 0, y: 0, width: 400, height: 400 },
      ),
    ).toEqual({ x: 0, y: 0, width: 400, height: 400 });
  });

  it('returns the region unchanged when a scale dimension is 0', () => {
    // No screenshot yet: dividing by a zero view width would produce NaN pixels.
    const r: Region = { x: 10, y: 20, width: 30, height: 40 };
    expect(
      scaleRegion(
        r,
        { x: 0, y: 0, width: 0, height: 0 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual(r);
    expect(
      scaleRegion(
        r,
        { x: 0, y: 0, width: 100, height: 0 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual(r);
    expect(
      scaleRegion(r, { x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 0 }),
    ).toEqual(r);
  });

  it('expands with padding and respects the bounds', () => {
    // A point grows into the 96x96 window a click verifies with.
    expect(expand({ x: 100, y: 100, width: 0, height: 0 }, 48)).toEqual({
      x: 52,
      y: 52,
      width: 96,
      height: 96,
    });
    // Clamped at the frame edge instead of reading pixels that do not exist.
    expect(
      expand({ x: 10, y: 10, width: 0, height: 0 }, 48, { x: 0, y: 0, width: 30, height: 30 }),
    ).toEqual({ x: 0, y: 0, width: 30, height: 30 });
    // Entirely outside the bounds: a zero-sized window pinned to the corner.
    expect(
      expand({ x: 500, y: 500, width: 10, height: 10 }, 5, { x: 0, y: 0, width: 100, height: 100 }),
    ).toEqual({ x: 100, y: 100, width: 0, height: 0 });
  });

  it('answers containment and overlap for edge shapes', () => {
    const frame: Region = { x: 0, y: 0, width: 100, height: 100 };
    expect(regionContains(frame, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
    expect(regionContains(frame, frame)).toBe(true);
    // Sticks out of the right edge.
    expect(regionContains(frame, { x: 90, y: 90, width: 20, height: 20 })).toBe(false);
    // A degenerate region is a point check.
    expect(regionContains(frame, { x: 50, y: 50, width: 0, height: 0 })).toBe(true);
    expect(regionContains(frame, { x: 500, y: 50, width: 0, height: 0 })).toBe(false);

    expect(
      regionsOverlap(
        { x: 0, y: 0, width: 50, height: 50 },
        { x: 40, y: 40, width: 20, height: 20 },
      ),
    ).toBe(true);
    // Touching along an edge shares no area.
    expect(
      regionsOverlap({ x: 0, y: 0, width: 50, height: 50 }, { x: 50, y: 0, width: 10, height: 10 }),
    ).toBe(false);
    // Degenerate and off-screen regions overlap nothing.
    expect(regionsOverlap(frame, { x: 10, y: 10, width: 0, height: 0 })).toBe(false);
    expect(regionsOverlap(frame, { x: 500, y: 500, width: 10, height: 10 })).toBe(false);
  });
});

describe('batch execution', () => {
  it('runs actions in order and cuts at the first failure', async () => {
    const { backend, calls } = fakeBackend({ failOnType: 'b' });
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const result = await tool.execute('t1', {
      action: 'batch',
      actions: [
        { action: 'type', text: 'a' },
        { action: 'type', text: 'b' },
        { action: 'type', text: 'c' },
      ],
    });
    // The third action never touches the backend: a half-applied sequence is
    // worse than a shorter one the model can see.
    expect(calls).toEqual(['type:a', 'type:b']);
    expect(batchResults(result.details)).toEqual([
      { index: 0, action: 'type', ok: true, result: { chars: 1, verified: null } },
      { index: 1, action: 'type', ok: false, error: 'type failed' },
      { index: 2, action: 'type', ok: false, error: 'skipped: action 1 did not complete' },
    ]);
  });

  it('passes every batch action through the gate exactly once', async () => {
    const { backend, calls } = fakeBackend();
    const seen: string[] = [];
    const gate: ActionGate = (call) => {
      seen.push(String(call.args.action));
      return { verdict: 'allow', reason: '' };
    };
    const tool = createComputerTool(makeConfig(), backend, gate);
    await tool.execute('t1', {
      action: 'batch',
      actions: [
        { action: 'type', text: 'a' },
        { action: 'key', key: 'enter' },
        { action: 'type', text: 'b' },
      ],
    });
    // One gate check per action — the batch must not smuggle sub-actions past
    // the check a standalone action would have faced.
    expect(seen).toEqual(['type', 'key', 'type']);
    expect(calls).toEqual(['type:a', 'key:enter', 'type:b']);
  });

  it('reports a gate-blocked action and cuts the rest', async () => {
    const { backend, calls } = fakeBackend();
    let checks = 0;
    const gate: ActionGate = () => {
      checks += 1;
      return checks === 2
        ? { verdict: 'deny', reason: 'not allowed' }
        : { verdict: 'allow', reason: '' };
    };
    const tool = createComputerTool(makeConfig(), backend, gate);
    const result = await tool.execute('t1', {
      action: 'batch',
      actions: [
        { action: 'type', text: 'a' },
        { action: 'key', key: 'enter' },
        { action: 'type', text: 'b' },
      ],
    });
    expect(calls).toEqual(['type:a']);
    // The blocked action is checked and reported; the one after it is never
    // even checked, because it is never run.
    expect(checks).toBe(2);
    expect(batchResults(result.details)).toEqual([
      { index: 0, action: 'type', ok: true, result: { chars: 1, verified: null } },
      { index: 1, action: 'key', ok: false, error: 'blocked: not allowed' },
      { index: 2, action: 'type', ok: false, error: 'skipped: action 1 did not complete' },
    ]);
  });

  it('refuses to run a batch when no gate is wired', async () => {
    // Fail closed: an unwired gate must not silently mean "allow everything".
    const { backend, calls } = fakeBackend();
    const tool = createComputerTool(makeConfig(), backend);
    const result = await tool.execute('t1', {
      action: 'batch',
      actions: [{ action: 'type', text: 'a' }],
    });
    expect(calls).toEqual([]);
    expect(batchResults(result.details)[0]?.error).toMatch(/blocked/);
  });

  it('says clearly that nothing ran and why when built without a gate', async () => {
    // The regression this pins down: the real app builds the tool without a gate,
    // and the batch then blocked on the first action with no explanation. The
    // failure must be visible and actionable - a report naming the missing
    // permission gate - not a confusing throw and not a silent cut.
    const { backend, calls } = fakeBackend();
    const tool = createComputerTool(makeConfig(), backend);
    const result = await tool.execute('t1', {
      action: 'batch',
      actions: [
        { action: 'type', text: 'a' },
        { action: 'key', key: 'enter' },
      ],
    });
    // Not a throw: a normal result that says nothing executed.
    expect(calls).toEqual([]);
    const first = result.content[0];
    const text = first && first.type === 'text' ? first.text : '';
    expect(text).toMatch(/falta el control de permisos/);
    expect(text).toMatch(/ninguna de las 2 acciones se ha ejecutado/i);
    const results = batchResults(result.details);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/falta el control de permisos/);
    }
  });

  it('runs every action when a gate is wired', async () => {
    // The counterpart of the case above: with the gate wired - as the app must -
    // the same batch reaches the backend in full and in order.
    const { backend, calls } = fakeBackend();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    const result = await tool.execute('t1', {
      action: 'batch',
      actions: [
        { action: 'type', text: 'a' },
        { action: 'key', key: 'enter' },
        { action: 'type', text: 'b' },
      ],
    });
    expect(calls).toEqual(['type:a', 'key:enter', 'type:b']);
    expect(batchResults(result.details).map((r) => r.ok)).toEqual([true, true, true]);
  });

  it('interprets click coordinates relative to the roi and scales them down', async () => {
    const { backend, calls } = fakeBackend();
    const tool = createComputerTool(makeConfig(), backend, allowAll);
    // First a full screenshot, so the model's pixel space is 1280x720.
    await tool.execute('t0', { action: 'screenshot' });
    await tool.execute('t1', {
      action: 'click',
      x: 10,
      y: 20,
      roi: { x: 100, y: 50, width: 200, height: 100 },
    });
    // (10,20) relative to the roi is (110,70) in the 1280x720 view, which is
    // (165,105) on the 1920x1080 desktop — one scaleRegion from the same maths
    // `toRealCoordinates` applies to absolute clicks.
    expect(calls).toContain('click:165,105');
    // Outside the roi the action is refused before it becomes a real event.
    await expect(
      tool.execute('t2', {
        action: 'click',
        x: 500,
        y: 0,
        roi: { x: 100, y: 50, width: 200, height: 100 },
      }),
    ).rejects.toThrow(/roi/);
  });

  it('verifies the whole batch once at the end, not per action', async () => {
    const { backend, calls } = fakeBackend();
    const tool = createComputerTool(makeConfig({ verifyActions: true }), backend, allowAll);
    const result = await tool.execute('t1', {
      action: 'batch',
      actions: [
        { action: 'key', key: 'a' },
        { action: 'key', key: 'b' },
        { action: 'key', key: 'c' },
      ],
    });
    // ONE before + ONE after for three actions: two captures per action is the
    // cost the batch exists to remove.
    expect(calls.filter((c) => c === 'screenshot')).toHaveLength(2);
    const first = result.content[0];
    const text = first && first.type === 'text' ? first.text : '';
    expect(text).toMatch(/VERIFICACION/);
    expect(text).toMatch(/\[0\] key: ok/);
  }, 30_000);
});

/**
 * Paint one frame with System.Drawing and return its bytes. Same approach as
 * verify.test.ts: a synthetic fixture would not exercise the real resampler and
 * luma path that decides "changed".
 */
async function paint(script: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pa-batch-paint-'));
  try {
    const target = join(dir, 'frame.png');
    const full = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 800, 600
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 30, 30))
${script}
$g.Dispose()
$bmp.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return readFileSync(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function asScreenshot(image: Buffer): Screenshot {
  return {
    image,
    mimeType: 'image/png',
    width: 800,
    height: 600,
    nativeWidth: 800,
    nativeHeight: 600,
  };
}

// Paints frames with PowerShell and System.Drawing, so Windows only.
describe.skipIf(!isWindows)('verifyBatch', () => {
  it('is done when a region changed', async () => {
    const empty = '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)';
    const typed = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
for ($i = 0; $i -lt 10; $i++) { $g.FillRectangle($brush, 100 + $i*12, 200, 8, 20) }`;
    const before = asScreenshot(await paint(empty));
    const after = asScreenshot(await paint(typed));
    const v = await verifyBatch([
      { before, after, roi: { x: 80, y: 180, width: 120, height: 60 } },
    ]);
    expect(v.done).toBe(true);
    expect(v.changed).toBe(1);
    expect(v.total).toBe(1);
    expect(v.reason).toMatch(/ha tenido efecto/);
  }, 30_000);

  it('is not done when nothing changed', async () => {
    const frame = asScreenshot(
      await paint('$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)'),
    );
    // The same frame before and after: an inert action must not read as success.
    const v = await verifyBatch([{ before: frame, after: frame }]);
    expect(v.done).toBe(false);
    expect(v.changed).toBe(0);
    expect(v.total).toBe(1);
    expect(v.reason).toMatch(/NO ha cambiado/);
  }, 30_000);
});
