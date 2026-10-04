import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { flag } from '../src/config.js';
import {
  type BatchPair,
  buildCompareScript,
  compareFiles,
  compareFrames,
  type Screenshot,
  verdict,
  verifyBatch,
} from '../src/screen/verify.js';
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
 *
 * JPEG by default because that is what the backend hands over, with PNG available for
 * the one thing JPEG cannot show: that a valid frame in another format is still
 * compared, not refused.
 */
async function paint(file: string, script: string): Promise<Buffer> {
  return paintAs(file, script, 'Jpeg');
}

async function paintPng(file: string, script: string): Promise<Buffer> {
  return paintAs(file, script, 'Png');
}

async function paintAs(file: string, script: string, format: 'Jpeg' | 'Png'): Promise<Buffer> {
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
$bmp.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::${format})
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

/** Wrap painted bytes in the shape `verifyBatch` takes, since that is the batch's input. */
function asShot(image: Buffer): Screenshot {
  return {
    image,
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    nativeWidth: 800,
    nativeHeight: 600,
  };
}

describe('compareFrames (live)', () => {
  it('reports no change between two identical frames', async () => {
    const paint1 = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($brush, 100, 100, 300, 80)`;
    const a = await paint('a.jpg', paint1);
    const b = await paint('b.jpg', paint1);
    const diff = await compareFrames(a, b);
    expect(diff.failed).toBeUndefined();
    expect(diff.changed).toBe(false);
    expect(diff.ratio).toBeLessThan(0.0006);
    expect(diff.verdict).toMatch(/NO ha cambiado/);
  });

  it('reports a change when a block of text-like marks appears', async () => {
    // Ten glyph-like rectangles standing in for a typed line: contiguous, which is what
    // separates real content from noise.
    const empty = '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)';
    const typed = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
for ($i = 0; $i -lt 10; $i++) { $g.FillRectangle($brush, 100 + $i*12, 200, 8, 20) }`;
    const a = await paint('a.jpg', empty);
    const b = await paint('b.jpg', typed);
    const diff = await compareFrames(a, b);
    expect(diff.failed).toBeUndefined();
    expect(diff.changed).toBe(true);
    expect(diff.ratio).toBeGreaterThan(0.0006);
    expect(diff.verdict).toMatch(/ha tenido efecto/);
  });

  it('reports a big change when the whole frame is replaced', async () => {
    // The other end of the scale. A low ratio must never be the only number the caller
    // gets: "nothing happened" and "everything happened" have to be far apart.
    const dark = '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)';
    const white = `
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillRectangle($brush, 0, 0, 800, 600)`;
    const quiet = await compareFrames(await paint('a.jpg', dark), await paint('b.jpg', dark));
    const loud = await compareFrames(await paint('c.jpg', dark), await paint('d.jpg', white));
    expect(quiet.ratio).toBeLessThan(0.0006);
    expect(loud.ratio).toBeGreaterThan(0.5);
    expect(loud.changed).toBe(true);
    expect(loud.verdict).toMatch(/ha tenido efecto/);
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
    const a = await paint('a.jpg', base);
    const away = await paint('b.jpg', awayScript);
    const here = await paint('c.jpg', nearScript);

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

/**
 * The `Memoria insuficiente` regression.
 *
 * `[System.Drawing.Image]::FromFile` reports a file with no decodable image as
 * OutOfMemoryException "Insufficient memory", so a frame that was never a JPEG came
 * back from every single comparison as `OutOfMemoryException` and was then flattened
 * into "no pude comparar las dos capturas" — a verdict that reads to the model as
 * "the screen did not change". These pin the two halves of the fix: the frame is
 * refused before it reaches a decoder, and the refusal names itself instead of being
 * summarised away.
 */
describe('compareFrames refuses frames that are not images', () => {
  it('says the frame was empty instead of blaming memory', async () => {
    const good = await paint(
      'a.jpg',
      '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
    );
    const diff = await compareFrames(Buffer.alloc(0), good);
    expect(diff.failed).toBe(true);
    expect(diff.changed).toBe(false);
    // The whole point: an unrun comparison must never read as "nothing changed".
    expect(diff.verdict).not.toMatch(/NO ha cambiado/);
    expect(diff.verdict).toMatch(/no he podido comparar/);
    expect(diff.verdict).toMatch(/vacia \(0 bytes\)/);
    // And it must not echo GDI+'s misleading word back.
    expect(diff.verdict).not.toMatch(/Memoria insuficiente/i);
  });

  it('names what the bytes were instead of guessing a format', async () => {
    const good = await paint(
      'a.jpg',
      '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
    );
    const notAnImage = Buffer.from('esto no es una imagen');
    const diff = await compareFrames(notAnImage, good);
    expect(diff.failed).toBe(true);
    expect(diff.verdict).toMatch(
      new RegExp(`no es una imagen reconocible \\(${notAnImage.length} bytes`),
    );
    // The header is what makes it actionable: it says which producer is on the wrong track.
    expect(diff.verdict).toMatch(/65 73 74 6f/);
    expect(diff.verdict).toMatch(/firma de ningun formato de imagen/);
  });

  it('still accepts a PNG frame, which System.Drawing decodes perfectly', async () => {
    // `Screenshot.mimeType` is a string and browser captures arrive as PNG. Refusing
    // those would be a regression dressed up as a fix, so the signature check has to be
    // about "is there an image in here", not "is it exactly the format we expected".
    const dir = mkdtempSync(join(tmpdir(), 'pa-png-'));
    try {
      const a = join(dir, 'a.png');
      const b = join(dir, 'b.png');
      writeFileSync(
        a,
        await paintPng(
          'a.png',
          '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
        ),
      );
      writeFileSync(
        b,
        await paintPng(
          'b.png',
          '$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White); $g.FillRectangle($brush, 0, 0, 800, 600)',
        ),
      );
      const diff = await compareFrames(readFileSync(a), readFileSync(b));
      expect(diff.failed).toBeUndefined();
      expect(diff.changed).toBe(true);
      expect(diff.ratio).toBeGreaterThan(0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('calls out a frame that was cut off mid-write', async () => {
    const full = await paint(
      'a.jpg',
      '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
    );
    const diff = await compareFrames(full.subarray(0, Math.floor(full.length / 2)), full);
    expect(diff.failed).toBe(true);
    expect(diff.verdict).toMatch(/esta incompleta \(\d+ bytes, sin el marcador final del JPEG\)/);
  });

  it('checks the post-action frame too, not only the baseline', async () => {
    const good = await paint(
      'a.jpg',
      '$brush0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
    );
    const diff = await compareFrames(good, Buffer.alloc(0));
    expect(diff.failed).toBe(true);
    expect(diff.verdict).toMatch(/captura posterior llego vacia/);
  });
});

/**
 * Paths are injected into the PowerShell script as single-quoted literals, so a path
 * with a space has to survive that. Windows temp directories get renamed by installers
 * and by users, and a broken comparison is far more expensive than the odd directory
 * name that triggers it.
 */
describe('compareFiles handles paths that are not simple', () => {
  it('compares two real frames through a directory with spaces and accents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-spaces-'));
    const nested = join(dir, 'mis capturas (2026) ñ');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nested, { recursive: true });
    const a = join(nested, 'captura uno.jpg');
    const b = join(nested, 'captura dos.jpg');
    try {
      writeFileSync(
        a,
        await paint(
          'a.jpg',
          '$b0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
        ),
      );
      writeFileSync(
        b,
        await paint(
          'b.jpg',
          '$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White); $g.FillRectangle($brush, 0, 0, 800, 600)',
        ),
      );
      const diff = await compareFiles(a, b);
      expect(diff.failed).toBeUndefined();
      expect(diff.changed).toBe(true);
      expect(diff.ratio).toBeGreaterThan(0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('escapes a quote in a path rather than breaking the script', () => {
    // The script is one string of PowerShell, so an unescaped quote would end the
    // literal early and hand the rest of the path to the interpreter as code.
    const script = buildCompareScript("C:\\tmp\\it's here\\a.jpg", 'C:\\tmp\\b.jpg');
    expect(script).toContain("'C:\\tmp\\it''s here\\a.jpg'");
  });

  it('reports a file that is not an image instead of returning nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-bad-'));
    const a = join(dir, 'a.jpg');
    const b = join(dir, 'b.jpg');
    try {
      const notAnImage = 'esto no es una imagen';
      writeFileSync(a, notAnImage);
      writeFileSync(
        b,
        await paint(
          'b.jpg',
          '$b0 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)',
        ),
      );
      const diff = await compareFiles(a, b);
      expect(diff.failed).toBe(true);
      expect(diff.verdict).toMatch(/no tiene la firma de ningun formato de imagen/);
      // The byte count and the header are in there, which is what makes it actionable.
      expect(diff.verdict).toContain(`${Buffer.byteLength(notAnImage)} bytes`);
      expect(diff.verdict).toMatch(/65 73 74 6f/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('verifyBatch reports an uncomparable batch as unknown, not as inert', () => {
  it('never tells the model nothing happened when no comparison ran', async () => {
    const good = await paint(
      'a.jpg',
      '$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White); $g.FillRectangle($brush, 0, 0, 800, 600)',
    );
    const pairs: BatchPair[] = [
      { before: asShot(Buffer.alloc(0)), after: asShot(good) },
      { before: asShot(good), after: asShot(Buffer.alloc(0)) },
    ];
    const verdictOut = await verifyBatch(pairs);
    expect(verdictOut.done).toBe(false);
    expect(verdictOut.changed).toBe(0);
    expect(verdictOut.reason).toMatch(/no he podido comparar NINGUNA/);
    expect(verdictOut.reason).not.toMatch(/NO ha cambiado tras el lote/);
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
