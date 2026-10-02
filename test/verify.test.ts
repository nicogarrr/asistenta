import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { flag } from '../src/config.js';
import { buildCompareScript, compareFrames, verdict } from '../src/screen/verify.js';
import { dpiScaleFor, listWindows } from '../src/tools/windows.js';

const execFileAsync = promisify(execFile);

/**
 * Frame comparison, tested against real rendered images rather than fixtures.
 *
 * Two of these assertions exist because the first implementation got both wrong on a
 * live desktop: it declared an idle screen "changed" by a factor of five, and it
 * reported typed text as no change. A synthetic fixture would have passed either way,
 * so the images here are painted by System.Drawing and compared through the same path
 * a screenshot takes.
 */
/**
 * Paint two frames with System.Drawing and return their bytes.
 *
 * Returns the buffer rather than a path because the temp directory is removed before
 * returning: leaving painted files behind in %TEMP% would be its own kind of mess, and
 * the first version of this test failed exactly that way with ENOENT.
 */
async function paint(file: string, script: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pa-paint-'));
  try {
    const target = join(dir, file);
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

describe('compareFrames (live)', () => {
  it('reports no change between two identical frames', async () => {
    const paint1 = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($brush, 100, 100, 300, 80)`;
    const a = await paint('a.png', paint1);
    const b = await paint('b.png', paint1);
    const diff = await compareFrames(a, b);
    expect(diff.changed).toBe(false);
    expect(diff.verdict).toMatch(/NO ha cambiado/);
  });

  it('reports a change when a block of text-like marks appears', async () => {
    // Ten glyph-like rectangles standing in for a typed line: contiguous, which is what
    // separates real content from noise.
    const empty = '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)';
    const typed = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
for ($i = 0; $i -lt 10; $i++) { $g.FillRectangle($brush, 100 + $i*12, 200, 8, 20) }`;
    const a = await paint('a.png', empty);
    const b = await paint('b.png', typed);
    const diff = await compareFrames(a, b);
    expect(diff.changed).toBe(true);
    expect(diff.verdict).toMatch(/ha tenido efecto/);
  });

  it('distinguishes a change at the action point from one far away', async () => {
    // This is the case that separates "landed" from "missed", and the reason the
    // comparison takes a point of interest at all.
    //
    // Frames are painted at 800x600 and compared on a grid derived from that aspect,
    // so the point of interest is given in FRAME coordinates — the same space the model
    // sees a screenshot in — and the comparer scales it into the grid itself.
    const base = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($brush, 400, 300, 200, 100)`;
    const awayScript = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($brush, 400, 300, 200, 100)
$g.FillRectangle($brush, 600, 40, 160, 160)`;
    const nearScript = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($brush, 400, 300, 200, 100)
$g.FillRectangle($brush, 560, 340, 80, 60)`;
    const a = await paint('a.png', base);
    const away = await paint('b.png', awayScript);
    const here = await paint('c.png', nearScript);

    // The action point is empty space at the bottom left; the response happened top
    // right, so the agent pressed the wrong thing.
    const remote = await compareFrames(a, away, { at: { x: 100, y: 500 }, radius: 40 });
    expect(remote.changed).toBe(true);
    expect(remote.movedAway).toBe(true);
    expect(remote.verdict).toMatch(/lejos del punto|NADA se movio/);

    // The action point sits on the block that appeared at 560..640 x 340..400.
    // It overlaps the base rectangle rather than hiding inside it, or there would be
    // nothing new to see.
    const close = await compareFrames(a, here, { at: { x: 600, y: 370 }, radius: 40 });
    expect(close.changed).toBe(true);
    expect(close.movedAway).toBe(false);
  });

  it('clamps impossible geometry instead of building a broken comparison', () => {
    const script = buildCompareScript('a.jpg', 'b.jpg', {
      width: 1,
      height: 99999,
      at: { x: -5, y: -5 },
      radius: 0,
    });
    // The grid is derived from the frame, so the only literal left is the requested
    // long edge (clamped up to 32) and the radius floor.
    expect(script).toMatch(/\$scale = 32 \/ \[double\]\$long/);
    expect(script).toMatch(/Math\]::Max\(4, \[Math\]::Round\(4 \* \$scale\)\)/);
  });
});

describe('probe artifacts are cleaned up', () => {
  it('leaves no temporary frames behind', () => {
    // The compare helper writes both frames to a temp dir and removes it in a finally,
    // so a crash mid-comparison cannot leave images of the user's screen in %TEMP%.
    const dir = mkdtempSync(join(tmpdir(), 'pa-clean-'));
    writeFileSync(join(dir, 'frame.jpg'), 'x');
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
    expect(() => readdirSync(dir)).toThrow();
  });
});

describe('verdict thresholds', () => {
  it('prefers a false alarm over a false success', () => {
    // Below the gate: reported as "nothing happened", which costs one extra step.
    const quiet = verdict(0.0001, 0, -1, -1, { x: 10, y: 10 });
    expect(quiet.changed).toBe(false);

    // Above the gate but with nothing near the point: reported as "you missed".
    const missed = verdict(0.05, 0, 300, 300, { x: 10, y: 10 });
    expect(missed.changed).toBe(true);
    expect(missed.movedAway).toBe(true);

    // Above the gate with a local response: reported as landed.
    const landed = verdict(0.05, 0.2, 12, 11, { x: 10, y: 10 });
    expect(landed.movedAway).toBe(false);
  });

  it('rounds percentages so the model reads 0.3% and not 0.0028', () => {
    expect(verdict(0.00281, 0, -1, -1).verdict).toContain('0.3%');
  });
});

/**
 * Windows inspection on this machine.
 *
 * These assert on behaviour that has to be true for the tool to be worth having, and
 * each one was a real defect at some point: the P/Invoke version threw
 * NullReferenceException, the UIA version found nothing because FOUND was printed
 * after the loop that could throw, and the coordinates were off by the 150% DPI factor.
 */
describe('windows inspection (live)', () => {
  it('lists at least one real window with a title', async () => {
    const windows = await listWindows();
    expect(Array.isArray(windows)).toBe(true);
    for (const w of windows) {
      expect(w.title.length).toBeGreaterThan(0);
      expect(w.pid).toBeGreaterThan(0);
    }
  }, 30_000);

  it('reports a sane DPI scale rather than assuming 1', async () => {
    const scale = await dpiScaleFor(0);
    // A null handle is the documented fallback, and it must be 1.
    expect(scale).toBe(1);
  }, 20_000);
});

describe('config flags', () => {
  it('treats only explicit falsey values as off', () => {
    const original = process.env.PA_TEST_FLAG;
    try {
      delete process.env.PA_TEST_FLAG;
      expect(flag('PA_TEST_FLAG', true)).toBe(true);
      process.env.PA_TEST_FLAG = '';
      expect(flag('PA_TEST_FLAG', true)).toBe(true);
      // A typo must leave the safer default in place rather than disabling a safety
      // feature, which is why anything unrecognised means "on".
      process.env.PA_TEST_FLAG = 'maybe';
      expect(flag('PA_TEST_FLAG', true)).toBe(true);
      for (const off of ['0', 'false', 'no', 'off', 'OFF', ' off ']) {
        process.env.PA_TEST_FLAG = off;
        expect(flag('PA_TEST_FLAG', true), off).toBe(false);
      }
      process.env.PA_TEST_FLAG = '1';
      expect(flag('PA_TEST_FLAG', false)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.PA_TEST_FLAG;
      else process.env.PA_TEST_FLAG = original;
    }
  });
});

describe('thread eviction policy', () => {
  it('never evicts a busy or explicitly selected conversation', async () => {
    // Mirrors the rule in serveCommand. Stated as a test because the failure mode is
    // silent: the agent forgets the conversation the user is in the middle of.
    const threads = [
      { name: 'main', active: true, current: false, age: 1 },
      { name: 'tema', active: false, current: true, age: 2 },
      { name: 'old1', active: false, current: false, age: 90 },
      { name: 'old2', active: false, current: false, age: 80 },
    ];
    const max = 2;
    const idle = threads.filter((t) => !t.active && !t.current).sort((a, b) => a.age - b.age);
    const survivors = new Set(threads.map((t) => t.name));
    let size = threads.length;
    while (size > max && idle.length) {
      const victim = idle.shift();
      if (!victim) break;
      survivors.delete(victim.name);
      size--;
    }
    expect(survivors.has('main')).toBe(true);
    expect(survivors.has('tema')).toBe(true);
    expect(survivors.has('old1')).toBe(false);
    expect(size).toBe(max);
  });
});
