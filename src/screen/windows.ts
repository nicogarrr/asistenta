import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScreenBackend } from '../tools/computer.js';
import {
  escapeForSendKeys,
  parseKeyChord,
  splitAsciiSegments,
  winChordVirtualKeys,
} from './keys.js';
import { jpegGeometry, parseCaptureGeometry, physicalScript } from './windows-geometry.js';

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
/** mouse_event flags for each button. Anything else is refused, never guessed. */
const MOUSE_FLAGS: Record<string, { down: string; up: string }> = {
  left: { down: '0x0002', up: '0x0004' },
  right: { down: '0x0008', up: '0x0010' },
  middle: { down: '0x0020', up: '0x0040' },
};

/** Down/up flags for a button name (case-insensitive). Throws on an unknown button. */
export function mouseButtonFlags(button: string): { down: string; up: string } {
  const flags = MOUSE_FLAGS[button.trim().toLowerCase()];
  if (!flags) {
    throw new Error(`botón de ratón desconocido: "${button}" (usa left, right o middle)`);
  }
  return flags;
}

export class WindowsScreen implements ScreenBackend {
  private readonly runPowerShell: (script: string) => Promise<{ stdout: string; stderr: string }>;
  constructor(runPowerShell?: (script: string) => Promise<{ stdout: string; stderr: string }>) {
    this.runPowerShell =
      runPowerShell ??
      (async (script) => {
        try {
          return await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
              encoding: 'utf8',
              maxBuffer: 16 * 1024 * 1024,
              timeout: POWERSHELL_TIMEOUT_MS,
              windowsHide: true,
            },
          );
        } catch (err) {
          throw powerShellError(err);
        }
      });
  }
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
    const { stdout } = await this.#physicalPs(captureScript(out, this.#maxEdge));
    if (!existsSync(out)) {
      throw new Error('screen capture produced no file (is there an interactive desktop session?)');
    }
    const jpeg = readFileSync(out);
    const geometry = parseCaptureGeometry(stdout);
    const actual = jpegGeometry(jpeg);
    if (actual.width !== geometry.width || actual.height !== geometry.height) {
      throw new Error('JPEG y geometría no coinciden; no se puede mapear el cursor.');
    }
    return { image: jpeg, mimeType: 'image/jpeg', ...geometry };
  }

  async screenSize(): Promise<{ width: number; height: number }> {
    const { stdout } = await this.#physicalPs(
      `$b=[PaDesktop]::Bounds(); Write-Output "PA_SIZE $($b[2])x$($b[3])"`,
    );
    const match = /^PA_SIZE ([1-9]\d*)x([1-9]\d*)\s*$/m.exec(stdout);
    if (!match) throw new Error('No se pudo verificar el tamaño físico de pantalla.');
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  async click(
    x: number,
    y: number,
    opts: { button?: string; clicks?: number } = {},
  ): Promise<void> {
    // Down and up flags come from ONE table: an unknown button used to send a
    // left-down followed by a middle-up, which left the left button held and turned
    // every later move into a drag.
    const flags = mouseButtonFlags(opts.button ?? 'left');
    const requested = Number(opts.clicks ?? 1);
    const clicks = Math.max(1, Math.min(5, Math.trunc(Number.isFinite(requested) ? requested : 1)));
    // SetCursorPos + mouse_event rather than SendInput: it does not require this
    // process to be the foreground window.
    const sequence = Array.from(
      { length: clicks },
      () =>
        `[M]::mouse_event(${flags.down},0,0,0,[IntPtr]::Zero); [M]::mouse_event(${flags.up},0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40`,
    ).join('\n');

    await this.#physicalPs(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
${ADD_TYPE_MOUSE}
if (-not [PaDesktop]::SetCursorPos(${x}, ${y})) { throw 'No se pudo mover el cursor físico.' }
Start-Sleep -Milliseconds 40
${sequence}
`);
  }

  async move(x: number, y: number): Promise<void> {
    await this.#physicalPs(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not [PaDesktop]::SetCursorPos(${x}, ${y})) { throw 'No se pudo mover el cursor físico.' }
`);
  }

  async drag(x: number, y: number, toX: number, toY: number): Promise<void> {
    await this.#physicalPs(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
${ADD_TYPE_MOUSE}
if (-not [PaDesktop]::SetCursorPos(${x}, ${y})) { throw 'No se pudo mover el cursor físico.' }
Start-Sleep -Milliseconds 80
[M]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
$steps = 12
for ($i=1; $i -le $steps; $i++) {
  $t = $i / $steps
  $nx = [int](${x} + (${toX} - ${x}) * $t)
  $ny = [int](${y} + (${toY} - ${y}) * $t)
  if (-not [PaDesktop]::SetCursorPos($nx, $ny)) { throw 'No se pudo arrastrar el cursor físico.' }
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
   * paste: every format on it (text, an image, copied files, HTML…) is copied
   * first and put back afterwards, and only once the target app has gone idle
   * after Ctrl+V — never over something the app or Nico put there meanwhile.
   */
  async type(text: string): Promise<void> {
    const total = Array.from(text).length;
    let done = 0;
    for (const segment of splitAsciiSegments(text)) {
      // Long ASCII runs go in chunks: one SendWait of a whole email body can outlast
      // the 30 s PowerShell timeout in a slow app, which killed the call halfway and
      // the model, told only "failed", typed the WHOLE text again (duplicated).
      const pieces =
        segment.kind === 'ascii' ? chunkText(segment.text, SENDKEYS_CHUNK) : [segment.text];
      for (const piece of pieces) {
        try {
          if (segment.kind === 'ascii') {
            const escaped = escapeForSendKeys(piece);
            await this.#ps(`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
`);
          } else {
            await this.#pasteText(piece);
          }
        } catch (err) {
          if (done === 0) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${reason}\nPartial: ${done} of ${total} characters were already typed before the failure — ` +
              'do not retype the whole text; take a screenshot and continue from where it stopped. ' +
              `Ya se habían escrito ${done} de ${total} caracteres.`,
          );
        }
        done += Array.from(piece).length;
      }
    }
  }

  async #pasteText(text: string): Promise<void> {
    // Base64 the payload across the process boundary: emoji and quotes survive
    // intact, and nothing needs escaping in the generated script.
    const payload = Buffer.from(text, 'utf8').toString('base64');
    await this.#ps(pasteScript(payload, pasteSettleMs(), pasteNoHistory()));
  }

  async key(key: string): Promise<void> {
    const vks = winChordVirtualKeys(key);
    const script = vks
      ? winChordScript(vks)
      : `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${parseKeyChord(key).replace(/'/g, "''")}')
`;
    try {
      await this.#ps(script);
    } catch (err) {
      // A PowerShell killed by the timeout never reaches the chord's `finally`
      // (nor SendKeys' own key-up), so Win/Ctrl/Shift/Alt can stay held and every
      // later keystroke on Nico's PC turns into a shortcut. Release whatever is
      // still down, best effort, and report the original failure.
      try {
        await this.#ps(releaseModifiersScript());
      } catch {}
      throw err;
    }
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

  async #physicalPs(script: string): Promise<{ stdout: string; stderr: string }> {
    return this.runPowerShell(physicalScript(script));
  }

  async #ps(script: string): Promise<{ stdout: string; stderr: string }> {
    return this.runPowerShell(script);
  }
}

const ADD_TYPE_MOUSE = `Add-Type @'
using System;using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
}
'@`;

/** Modifier virtual keys `releaseModifiersScript` checks: Win L/R, Shift, Ctrl, Alt (generic + L/R). */
export const MODIFIER_VKS: readonly number[] = [
  0x5b, 0x5c, 0x10, 0xa0, 0xa1, 0x11, 0xa2, 0xa3, 0x12, 0xa4, 0xa5,
];

/**
 * Key-up for every modifier Windows still reports as down, and only those: a
 * key-up for a key that is not held is never sent. When a Win key is released a
 * harmless unassigned key (0xE8) is tapped first so the lone Win key-up does not
 * open the Start menu.
 */
export function releaseModifiersScript(): string {
  const list = MODIFIER_VKS.map((vk) => `0x${vk.toString(16).padStart(2, '0')}`).join(',');
  return `
$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.Runtime.InteropServices;
public class R {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
}
'@
$held = @(${list}) | Where-Object { ([R]::GetAsyncKeyState($_) -band 0x8000) -ne 0 }
if ($held | Where-Object { $_ -eq 0x5b -or $_ -eq 0x5c }) {
  [R]::keybd_event(0xe8,0,0,[UIntPtr]::Zero); [R]::keybd_event(0xe8,0,2,[UIntPtr]::Zero)
}
foreach ($vk in $held) { [R]::keybd_event([byte]$vk,0,2,[UIntPtr]::Zero) }
Write-Output ("released:" + ($held -join ','))
`;
}

/**
 * Key-down for each code in order, then key-up in reverse order, released in a
 * `finally` so a failure halfway never leaves the Windows key (or a modifier) held.
 */
export function winChordScript(vks: readonly number[]): string {
  const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;
  const down = vks.map((vk) => `  [K]::keybd_event(${hex(vk)},0,0,[UIntPtr]::Zero)`).join('\n');
  const up = [...vks]
    .reverse()
    .map((vk) => `  [K]::keybd_event(${hex(vk)},0,2,[UIntPtr]::Zero)`)
    .join('\n');
  return `
$ErrorActionPreference='Stop'
Add-Type @'
using System;using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
}
'@
try {
${down}
  Start-Sleep -Milliseconds 30
} finally {
${up}
}
`;
}

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
export function captureScript(out: string, maxEdge: number): string {
  const path = out.replace(/'/g, "''");
  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [PaDesktop]::Bounds()
$w = $b[2]
$h = $b[3]
$maxEdge = ${Math.max(0, Math.trunc(maxEdge))}
$long = [Math]::Max($w, $h)
$scale = 1.0
if ($maxEdge -gt 0 -and $long -gt $maxEdge) { $scale = $maxEdge / [double]$long }
$tw = [int][Math]::Round($w * $scale)
$th = [int][Math]::Round($h * $scale)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b[0], $b[1], 0, 0, $bmp.Size)
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
Write-Output ('PA_CAPTURE ' + (@{width=$tw;height=$th;nativeWidth=$w;nativeHeight=$h} | ConvertTo-Json -Compress))
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

/** Default pause after Ctrl+V before the clipboard is restored (ms). */
export const DEFAULT_PASTE_SETTLE_MS = 400;

/**
 * Pause after Ctrl+V before restoring the clipboard: `PA_COMPUTER_PASTE_SETTLE_MS`
 * (100–5000), default 400. Slow apps (Electron, remote desktops) read the
 * clipboard asynchronously; restoring too early pastes the OLD content.
 */
export function pasteSettleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PA_COMPUTER_PASTE_SETTLE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PASTE_SETTLE_MS;
  return Math.min(5000, Math.max(100, Math.round(raw)));
}

/**
 * PowerShell for one clipboard paste. Exported for tests (no Windows here).
 *
 * 1. Snapshot EVERY format on the clipboard into a private DataObject — an image
 *    or copied files survive, not only plain text (before, a non-text clipboard
 *    was overwritten with '' and Nico's copied image was lost).
 * 2. Put the text, Ctrl+V.
 * 3. Wait for the foreground app to go input-idle (up to 2 s), then the settle.
 * 4. Restore only if the clipboard still holds OUR text: if the app or Nico put
 *    something new there meanwhile, it is left alone.
 * An empty clipboard is emptied again; one that could not be read is left as is.
 */
/** How the paste puts our text on the clipboard (unchanged default). */
const PLAIN_SET = 'Pa-Retry { [System.Windows.Forms.Clipboard]::SetText($text) } | Out-Null';

/**
 * Same text, plus the formats Windows reads to keep an item out of Win+V history,
 * out of cloud clipboard sync and away from clipboard monitors (DWORD 0 / any).
 */
const NO_HISTORY_SET = `$zero = { New-Object System.IO.MemoryStream(,[byte[]](0,0,0,0)) }
$do = New-Object System.Windows.Forms.DataObject
$do.SetText($text)
$do.SetData('CanIncludeInClipboardHistory', (& $zero))
$do.SetData('CanUploadToCloudClipboard', (& $zero))
$do.SetData('ExcludeClipboardContentFromMonitorProcessing', (& $zero))
Pa-Retry { [System.Windows.Forms.Clipboard]::SetDataObject($do, $true) } | Out-Null`;

/**
 * `PA_COMPUTER_PASTE_NO_HISTORY=1` keeps text Computer Use pastes (emoji, braces,
 * accented runs) out of Nico's Win+V clipboard history and cloud sync. Off by
 * default: the plain paste is what has been proven on his PC.
 */
export function pasteNoHistory(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_COMPUTER_PASTE_NO_HISTORY === '1';
}

export function pasteScript(payloadB64: string, settleMs: number, noHistory = false): string {
  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class PaFg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }
"@
function Pa-Retry([scriptblock]$b) { for ($i=0; $i -lt 5; $i++) { try { return (& $b) } catch { Start-Sleep -Milliseconds 60 } }; return (& $b) }
$saved = $null; $hadFormats = $false
try {
  $current = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($null -ne $current) {
    $formats = @($current.GetFormats($false))
    if ($formats.Count -gt 0) {
      $hadFormats = $true
      $copy = New-Object System.Windows.Forms.DataObject
      $kept = 0
      foreach ($f in $formats) { try { $v = $current.GetData($f, $false); if ($null -ne $v) { $copy.SetData($f, $false, $v); $kept++ } } catch {} }
      if ($kept -gt 0) { $saved = $copy }
    }
  }
} catch {}
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64}'))
${noHistory ? NO_HISTORY_SET : PLAIN_SET}
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^v')
try {
  $fgPid = [uint32]0
  [void][PaFg]::GetWindowThreadProcessId([PaFg]::GetForegroundWindow(), [ref]$fgPid)
  if ($fgPid -gt 0) { [void](Get-Process -Id $fgPid).WaitForInputIdle(2000) }
} catch {}
Start-Sleep -Milliseconds ${Math.round(settleMs)}
$stillOurs = $false
try { $stillOurs = ([System.Windows.Forms.Clipboard]::ContainsText() -and [System.Windows.Forms.Clipboard]::GetText() -ceq $text) } catch {}
if ($stillOurs) {
  if ($null -ne $saved) {
    try { Pa-Retry { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true) } | Out-Null } catch {}
  } elseif (-not $hadFormats) {
    try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
  }
}
`;
}

/** execFile timeout for one desktop PowerShell call (ms). */
export const POWERSHELL_TIMEOUT_MS = 30_000;

/**
 * A short, script-free error for a failed PowerShell call.
 *
 * Node's execFile error message is `Command failed: powershell.exe … -Command
 * <the whole script>` and PowerShell's own stderr quotes the failing line
 * (`+ [System.Windows.Forms.SendKeys]::SendWait('…')`). Both put the text being
 * typed — and kilobytes of Add-Type C# — into the tool result the model reads
 * and that can reach the chat. Keep only PowerShell's error sentence; say
 * plainly when it was the timeout.
 */
export function powerShellError(err: unknown, timeoutMs = POWERSHELL_TIMEOUT_MS): Error {
  const e = (err ?? {}) as {
    killed?: boolean;
    signal?: string | null;
    code?: unknown;
    stderr?: unknown;
  };
  if (e.killed || e.signal === 'SIGTERM') {
    return new Error(
      `PowerShell no respondió en ${Math.round(timeoutMs / 1000)} s y se cortó (el PC va lento o la ventana no responde).`,
    );
  }
  if (e.code === 'ENOENT') return new Error('No encuentro powershell.exe en este equipo.');
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const lines: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^At line:\d+|^En línea: ?\d+|^Line \||^\+|^\d+ \||^#< CLIXML|^<Objs/i.test(line)) break;
    if (line) lines.push(line);
  }
  const reason = lines.join(' ').replace(/\s+/g, ' ').trim();
  const short = reason.length > 300 ? `${reason.slice(0, 297)}…` : reason;
  const code = typeof e.code === 'number' ? ` (código ${e.code})` : '';
  return new Error(
    short ? `PowerShell falló${code}: ${short}` : `PowerShell falló${code} sin mensaje de error.`,
  );
}

/** Max characters per SendKeys call (each call is one PowerShell process, 30 s timeout). */
export const SENDKEYS_CHUNK = 200;

/** Splits text into pieces of at most `size` code points (never inside an emoji). */
export function chunkText(text: string, size: number): string[] {
  const chars = Array.from(text);
  if (chars.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}
