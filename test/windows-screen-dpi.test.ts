import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { captureScript, WindowsScreen } from '../src/screen/windows.js';
import {
  jpegGeometry,
  parseCaptureGeometry,
  physicalScript,
} from '../src/screen/windows-geometry.js';
import { createComputerTool } from '../src/tools/computer.js';

// JPEG SOF header fixture only, for geometry parsing. Native test below uses real JPEG pixels.
function header(width: number, height: number): Buffer {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}
const geometry = { width: 1280, height: 853, nativeWidth: 2160, nativeHeight: 1440 };
const output = (g = geometry) => `PA_CAPTURE ${JSON.stringify(g)}\r\n`;
it('reproduces the old whitespace bug, then requires exact capture metadata and JPEG agreement', async () => {
  expect(/(\d+)x(\d+)/.exec('1280 x 853')).toBeNull();
  expect(parseCaptureGeometry(output())).toEqual(geometry);
  expect(() => parseCaptureGeometry('1280 x 853')).toThrow('ausente');
  expect(() => parseCaptureGeometry(output() + output())).toThrow('ambigua');
  expect(jpegGeometry(header(1280, 853))).toEqual({ width: 1280, height: 853 });
  expect(() => jpegGeometry(Buffer.from('not a jpeg'))).toThrow();
});
it.each([1.5, 2])(
  '2160x1440 desktop at %sx Windows scale: model capture and click/move/drag remain physical',
  async (dpiScale) => {
    const logical = { width: 2160 / dpiScale, height: 1440 / dpiScale };
    const scripts: string[] = [];
    const screen = new WindowsScreen(async (script) => {
      scripts.push(script);
      // A DPI-unaware invocation would report logical dimensions and crop the native desktop.
      expect(script.indexOf('SetThreadDpiAwarenessContext($physicalContext)')).toBeLessThan(
        script.indexOf('try {'),
      );
      expect(script).toContain('GetThreadDpiAwarenessContext()');
      expect(script).toContain('finally');
      if (script.includes('$bmp.Save')) {
        const file = /\$bmp.Save\('([^']+)'/.exec(script)?.[1];
        if (!file) throw new Error('capture target missing');
        expect(script).not.toContain('PrimaryScreen.Bounds');
        writeFileSync(file, header(1280, 853));
        return { stdout: output(), stderr: '' };
      }
      if (script.includes('PA_SIZE')) return { stdout: 'PA_SIZE 2160x1440\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const tool = createComputerTool(
      { screenshotMaxEdge: 1280, screenshotQuality: 80, verifyActions: false } as Config,
      screen,
    );
    try {
      const shot = await tool.execute('shot', { action: 'screenshot' });
      expect(shot.details).toMatchObject(geometry);
      expect(shot.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Screenshot 1280x853.'),
      });
      expect(geometry.nativeWidth).not.toBe(logical.width);
      const x = 1180;
      const y = 803;
      const realX = Math.round((x * 2160) / 1280);
      const realY = Math.round((y * 1440) / 853);
      await tool.execute('click', { action: 'click', x, y });
      expect(scripts.at(-1)).toContain(`[PaDesktop]::SetCursorPos(${realX}, ${realY})`);
      await tool.execute('move', { action: 'move', x, y });
      expect(scripts.at(-1)).toContain(`[PaDesktop]::SetCursorPos(${realX}, ${realY})`);
      await tool.execute('drag', { action: 'drag', x, y, toX: 640, toY: 426 });
      expect(scripts.at(-1)).toContain(`[PaDesktop]::SetCursorPos(${realX}, ${realY})`);
      expect(scripts.at(-1)).toContain('[PaDesktop]::SetCursorPos($nx, $ny)');
      expect(scripts.at(-1)).toContain('$nx = [int](');
    } finally {
      await screen.dispose();
    }
  },
);
it('rejects inconsistent capture metadata instead of guessing native size', async () => {
  const screen = new WindowsScreen(async (script) => {
    const file = /\$bmp.Save\('([^']+)'/.exec(script)?.[1];
    if (!file) throw new Error('capture target missing');
    writeFileSync(file, header(1440, 960));
    return { stdout: output(), stderr: '' };
  });
  try {
    await expect(screen.screenshot()).rejects.toThrow('no coinciden');
  } finally {
    await screen.dispose();
  }
});
it.each([
  { ...geometry, height: 720 },
  { ...geometry, width: 0 },
  { ...geometry, nativeWidth: Number.NaN },
])('rejects invalid aspect or size %j', (g) => {
  expect(() => parseCaptureGeometry(output(g))).toThrow();
});

describe.skipIf(process.platform !== 'win32')(
  'native Windows synthetic pixels, never capture the runner desktop or move its cursor',
  () => {
    it.each([1.5, 2])(
      'full 3:2 image at %sx scale preserves all four corners, metadata and actual JPEG dimensions',
      (scale) => {
        const dir = mkdtempSync(join(tmpdir(), 'pa-dpi-native-'));
        try {
          const file = join(dir, 'scaled.jpg');
          // Replace ONLY the desktop source with a painted bitmap. Rest is production capture/downscale/encode.
          const script = captureScript(file, 1280)
            .replace(
              '$b = [PaDesktop]::Bounds()',
              `$logicalW=${2160 / scale}; $logicalH=${1440 / scale}; $b = @(0,0,[int]($logicalW*${scale}),[int]($logicalH*${scale}))`,
            )
            .replace(
              '$g.CopyFromScreen($b[0], $b[1], 0, 0, $bmp.Size)',
              `$g.Clear([System.Drawing.Color]::White)
$g.FillRectangle([System.Drawing.Brushes]::Red,0,0,180,180)
$g.FillRectangle([System.Drawing.Brushes]::Green,1980,0,180,180)
$g.FillRectangle([System.Drawing.Brushes]::Blue,0,1260,180,180)
$g.FillRectangle([System.Drawing.Brushes]::Black,1980,1260,180,180)`,
            );
          const inspect = `
$im=[System.Drawing.Bitmap]::FromFile('${file.replace(/'/g, "''")}')
try {
if($im.Width -ne 1280 -or $im.Height -ne 853){throw 'JPEG geometry'}
$c=$im.GetPixel(20,20);if($c.R -lt 180 -or $c.B -gt 80){throw 'red corner missing'}
$c=$im.GetPixel(1260,20);if($c.G -lt 80 -or $c.R -gt 80){throw 'green corner missing'}
$c=$im.GetPixel(20,833);if($c.B -lt 180 -or $c.R -gt 80){throw 'blue corner missing'}
$c=$im.GetPixel(1260,833);if($c.R -gt 50 -or $c.B -gt 50){throw 'black corner missing'}
}finally{$im.Dispose()}
`;
          const stdout = execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(physicalScript(script + inspect), 'utf16le').toString('base64'),
            ],
            { encoding: 'utf8', timeout: 20000 },
          );
          expect(parseCaptureGeometry(stdout)).toEqual(geometry);
          expect(jpegGeometry(readFileSync(file))).toEqual({ width: 1280, height: 853 });
          mkdirSync('test-output', { recursive: true });
          writeFileSync(`test-output/dpi-${scale * 100}.jpg`, readFileSync(file));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
