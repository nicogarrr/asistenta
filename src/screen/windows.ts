import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScreenBackend } from '../tools/computer.js';
import { escapeForSendKeys, parseKeyChord, splitAsciiSegments } from './keys.js';

const execFileAsync = promisify(execFile);

/**
 * Windows screen backend.
 *
 * Deliberately PowerShell/.NET rather than robotjs or nut.js:
 * - nut.js's element-inspector (the UI Automation part we would want later) is a
 *   paid plugin, and its prebuilt binaries are not free.
 * - robotjs is CJS with native prebuilds and its capture path is not what we use.
 * - System.Drawing and SendInput are already on the machine, so this adds no native
 *   dependency and nothing to rebuild when Node is upgraded.
 *
 * The cost is a PowerShell round trip per action (~100-300ms). At one or two
 * screenshots per step that is acceptable; if latency shows up later, the fix is a
 * small native helper, not a rewrite.
 */
export class WindowsScreen implements ScreenBackend {
  #tempDir: string | null = null;
  /**
   * Downscaling policy for the next capture. Native capture at 1080p costs ~2.9k
   * tokens per image and a long run carries dozens of them; at 1280 on the long
   * edge the same screen reads at ~1.5k. The computer tool sets this from config.
   */
  #maxEdge = 0;

  /** Applies screenshot scaling to every subsequent capture. 0 disables it. */
  setScaling(maxEdge: number): void {
    this.#maxEdge = maxEdge;
  }

  async screenshot(): Promise<{
    image: Buffer;
    mimeType: string;
    /** Size of the returned image. Coordinates the model uses are in this space. */
    width: number;
    height: number;
    /** Real desktop size, needed to convert image coordinates into real ones. */
    nativeWidth: number;
    nativeHeight: number;
  }> {
    const dir = this.#temp();
    const out = join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    const { stdout } = await this.#ps(captureScript(out, this.#maxEdge));
    if (!existsSync(out)) {
      throw new Error('screen capture produced no file (is there an interactive desktop session?)');
    }
    const jpeg = readFileSync(out);
    const native = await this.screenSize();
    // The script echoes the size it actually wrote. Parsing it rather than
    // recomputing the scale in JS means the two can never disagree: if PowerShell
    // decided not to scale, the coordinates follow.
    const written = /(\d+)x(\d+)/.exec(stdout);
    const width = written ? Number(written[1]) : native.width;
    const height = written ? Number(written[2]) : native.height;
    return {
      image: jpeg,
      mimeType: 'image/jpeg',
      width,
      height,
      nativeWidth: native.width,
      nativeHeight: native.height,
    };
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const { stdout } = await this.#ps(
      'Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output "$($s.Width)x$($s.Height)"',
    );
    const m = /(\d+)x(\d+)/.exec(stdout);
    if (!m) throw new Error(`could not read screen size, got ${JSON.stringify(stdout)}`);
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  async click(
    x: number,
    y: number,
    opts: { button?: string; clicks?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left';
    const clicks = Math.max(1, Math.min(5, Math.trunc(opts.clicks ?? 1)));
    // SetCursorPos + mouse_event rather than SendInput: it does not require this
    // process to be the foreground window.
    const flag = button === 'right' ? '0x0008' : button === 'middle' ? '0x0020' : '0x0002';
    const sequence = Array.from(
      { length: clicks },
      () =>
        `[M]::mouse_event(${flag},0,0,0,[IntPtr]::Zero); [M]::mouse_event(${button === 'left' ? '0x0004' : flag === '0x0008' ? '0x0010' : '0x0040'},0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40`,
    ).join('\n');

    await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
${ADD_TYPE_MOUSE}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 40
${sequence}
`);
  }

  async move(x: number, y: number): Promise<void> {
    await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
`);
  }

  async drag(x: number, y: number, toX: number, toY: number): Promise<void> {
    await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
${ADD_TYPE_MOUSE}
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 80
[M]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
$steps = 12
for ($i=1; $i -le $steps; $i++) {
  $t = $i / $steps
  $nx = [int](${x} + (${toX} - ${x}) * $t)
  $ny = [int](${y} + (${toY} - ${y}) * $t)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($nx, $ny)
  Start-Sleep -Milliseconds 25
}
[M]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
`);
  }

  /**
   * Real keystrokes via SendKeys for ASCII, via clipboard paste for the rest.
   *
   * SendKeys cannot emit emoji or most non-ASCII: it either drops them or types
   * garbage. So text is split into ASCII runs (typed as keystrokes) and non-ASCII
   * runs (pasted with Ctrl+V). The clipboard is saved and restored around each
   * paste, best-effort: if the previous content was not plain text, there is
   * nothing sensible to restore and it is left as the pasted text.
   */
  async type(text: string): Promise<void> {
    for (const segment of splitAsciiSegments(text)) {
      if (segment.kind === 'ascii') {
        const escaped = escapeForSendKeys(segment.text);
        await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
`);
      } else {
        await this.#pasteText(segment.text);
      }
    }
  }

  async #pasteText(text: string): Promise<void> {
    // Base64 the payload across the process boundary: emoji and quotes survive
    // intact, and nothing needs escaping in the generated script.
    const payload = Buffer.from(text, 'utf8').toString('base64');
    await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$previous = $null
try { $previous = Get-Clipboard -Raw -ErrorAction Stop } catch {}
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 200
if ($null -ne $previous) {
  try { Set-Clipboard -Value $previous } catch {}
} else {
  try { Set-Clipboard -Value '' } catch {}
}
`);
  }

  async key(key: string): Promise<void> {
    const seq = parseKeyChord(key);
    await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${seq.replace(/'/g, "''")}')
`);
  }

  async dispose(): Promise<void> {
    if (!this.#tempDir) return;
    try {
      rmSync(this.#tempDir, { recursive: true, force: true });
    } catch {}
    this.#tempDir = null;
  }

  #temp(): string {
    this.#tempDir ??= mkdtempSync(join(tmpdir(), 'pa-shot-'));
    return this.#tempDir;
  }

  async #ps(script: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
  }
}

const ADD_TYPE_MOUSE = `Add-Type @'
using System;using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
}
'@`;

/**
 * Capture, optionally downscale, save as JPEG, and echo the size actually written.
 *
 * The downscale happens here rather than in Node because System.Drawing is already
 * on the machine: no native image dependency, no extra process, and one PowerShell
 * round trip either way. HighQualityBicubic matters — nearest-neighbour at 0.66x
 * turns 9pt UI text into unreadable speckle, which costs more steps than the tokens
 * it saves.
 *
 * JPEG quality is deliberately left at the encoder's own default. Setting it
 * explicitly needs `ImageCodecInfo.GetImageEncoders()` plus `EncoderParameters`, and
 * Windows Defender refuses to run that script: it rejects the whole thing as
 * `ScriptContainedMaliciousContent` ("this script contains malicious elements and has
 * been blocked by antivirus software"), with no way to pass anything to make it run.
 * The default is 75, which is within a few kilobytes of the 80 that was configured,
 * so the setting is dropped rather than kept as a knob that does nothing. The
 * alternative would be a native image encoder, which costs more than the bytes it
 * saves.
 */
function captureScript(out: string, maxEdge: number): string {
  const path = out.replace(/'/g, "''");
  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = $b.Width
$h = $b.Height
$maxEdge = ${Math.max(0, Math.trunc(maxEdge))}
$long = [Math]::Max($w, $h)
$scale = 1.0
if ($maxEdge -gt 0 -and $long -gt $maxEdge) { $scale = $maxEdge / [double]$long }
$tw = [int][Math]::Round($w * $scale)
$th = [int][Math]::Round($h * $scale)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
if ($scale -lt 1.0) {
  $small = New-Object System.Drawing.Bitmap $tw, $th
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.DrawImage($bmp, 0, 0, $tw, $th)
  $g2.Dispose()
  $bmp.Dispose()
  $bmp = $small
}
$bmp.Save('${path}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output "$tw x $th"
`;
}

/**
 * Whether a real interactive desktop is available. Screen capture needs an
 * interactive session: under a service or over SSH session 0, this returns a black
 * image or fails outright, and computer use is simply not possible. Checked at
 * startup so the agent can say so rather than failing on the first screenshot.
 */
export async function hasInteractiveDesktop(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).SessionId'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    return Number(stdout.trim()) !== 0;
  } catch {
    return false;
  }
}
