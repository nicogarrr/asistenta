import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

/**
 * Did that action actually do anything?
 *
 * This exists because of the single most expensive failure in GUI work: the agent
 * clicks, sees no signal that it failed, and clicks again. Measured across
 * benchmark suites, ineffective or repeated actions account for the large majority
 * of failed runs, and "assume the action succeeded" is its own documented category.
 *
 * The check is deliberately free. Asking the model whether its action worked costs
 * a call, tends to answer yes, and — in the one ablation worth remembering — a model
 * trained only on successful trajectories gets *worse* at verification, because it
 * becomes more confident in actions that were sometimes wrong. A pixel diff cannot
 * be talked into agreeing with you.
 *
 * Three outcomes, which need different recoveries and must not be collapsed into one:
 *
 *   no change at all      -> the click missed or the control is inert
 *   change near the point -> the action plausibly landed; go on
 *   change elsewhere only -> a neighbouring control responded, or something behind
 *                            the window did
 *
 * The diff runs in PowerShell with System.Drawing rather than in Node because that
 * is what already decodes the JPEG in `WindowsScreen`: adding a native image
 * dependency to answer this question would cost more than the question.
 */
export interface FrameDiff {
  /** Nothing perceptibly changed anywhere. */
  changed: boolean;
  /** Fraction of pixels that differ, 0-1. */
  ratio: number;
  /** Fraction differing inside a box around the action point, 0-1. */
  localRatio: number;
  /** True when the biggest local cluster is somewhere else entirely. */
  movedAway: boolean;
  /** One line the model can act on. */
  verdict: string;
}

export interface CompareOptions {
  /** Where the action happened, in the same pixel space as the frames. */
  at?: { x: number; y: number };
  /** Half-width of the region around the action point, in pixels. */
  radius?: number;
  /** Downscaled comparison size. Small on purpose: a hash, not a picture. */
  width?: number;
  height?: number;
}

/** Compact the two frames and return the numbers. Never throws on a failed capture. */
export async function compareFrames(
  before: Buffer,
  after: Buffer,
  options: CompareOptions = {},
): Promise<FrameDiff> {
  const dir = mkdtempSync(join(tmpdir(), 'pa-diff-'));
  const a = join(dir, 'a.jpg');
  const b = join(dir, 'b.jpg');
  try {
    writeFileSync(a, before);
    writeFileSync(b, after);
    return await compareFiles(a, b, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function compareFiles(
  fileA: string,
  fileB: string,
  options: CompareOptions = {},
): Promise<FrameDiff> {
  if (!existsSync(fileA) || !existsSync(fileB))
    return noChange('no pude comparar las dos capturas');

  let stdout: string;
  try {
    const { stdout: out } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildCompareScript(fileA, fileB, options)],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 20_000 },
    );
    stdout = out;
  } catch (err) {
    log.warn('frame compare failed', { err });
    return noChange('no pude comparar las dos capturas');
  }

  const m = /([\d.]+)\|([\d.]+)\|(-?\d+)\|(-?\d+)/.exec(stdout);
  if (!m) return noChange('no pude interpretar la comparación');
  return verdict(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), options.at);
}

/**
 * The PowerShell that does the actual comparison, as a pure function.
 *
 * Exported so it can be inspected and tested without a screen: the arithmetic lives
 * in PowerShell because System.Drawing is what already decodes our JPEGs, and the
 * first version of this had a bug in exactly the part that is hardest to see from
 * the outside.
 */
export function buildCompareScript(
  fileA: string,
  fileB: string,
  options: CompareOptions = {},
): string {
  const w = clamp(options.width ?? 320, 32, 1920);
  const at = options.at;
  const radius = clamp(options.radius ?? 40, 4, 400);
  // The ROI is expressed in the coordinate space of the frames, which is the same
  // size the frames were captured at, so no further scaling is needed here.
  const roi = at ? { x: Math.round(at.x), y: Math.round(at.y), r: Math.round(radius) } : null;

  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$probe = [System.Drawing.Image]::FromFile('${fileA.replace(/'/g, "''")}')
# The comparison grid is derived from the FIRST frame's aspect ratio rather than being
# a fixed 320x180. Hardcoding the grid stretches every frame that is not exactly 16:9,
# and a stretched frame puts the region of interest somewhere other than where the
# click was — which silently turns "did anything change under my cursor" into a
# question about a different part of the screen. This machine is 1234x823, which is not
# 16:9 at all.
$long = [Math]::Max($probe.Width, $probe.Height)
$scale = ${w} / [double]$long
$W = [int][Math]::Max(16, [Math]::Round($probe.Width * $scale))
$H = [int][Math]::Max(16, [Math]::Round($probe.Height * $scale))
$probe.Dispose()
function Load-Gray([string]$p) {
  $src = [System.Drawing.Image]::FromFile($p)
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  # HighQualityBicubic: nearest-neighbour resampling turns a small layout shift into
  # a large apparent diff, and then every frame looks changed.
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $W, $H)
  $g.Dispose()
  $src.Dispose()
  $out = New-Object 'System.Byte[]' ($W * $H)
  $k = 0
  for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
      $c = $bmp.GetPixel($x, $y)
      # Luma, not RGB: a hue shift at equal brightness is a real UI state change
      # (a button turning green) that an RGB distance mostly misses.
      $out[$k] = [byte]([Math]::Min(255, [int](0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)))
      $k++
    }
  }
  $bmp.Dispose()
  return $out
}
$A = Load-Gray '${fileA.replace(/'/g, "''")}'
$B = Load-Gray '${fileB.replace(/'/g, "''")}'
${
  roi
    ? `
# The point of interest arrives in the coordinate space of the frame the model was
# shown, so it is scaled by the same factor the grid was built with. Missing this is
# what made the region of interest land somewhere other than the click.
$roiX = [int][Math]::Round(${roi.x} * $scale)
$roiY = [int][Math]::Round(${roi.y} * $scale)
$roiR = [int][Math]::Max(4, [Math]::Round(${roi.r} * $scale))
$roiX1 = [Math]::Max(0, $roiX - $roiR)
$roiY1 = [Math]::Max(0, $roiY - $roiR)
$roiX2 = [Math]::Min($W - 1, $roiX + $roiR)
$roiY2 = [Math]::Min($H - 1, $roiY + $roiR)
# The ROI AREA, not the number of changed pixels inside it. Dividing by the changed
# count instead answers "how clustered is the change" when the question is "how much
# of the area under the cursor changed", and it makes a single changed pixel look
# like a complete response.
$roiArea = ($roiX2 - $roiX1 + 1) * ($roiY2 - $roiY1 + 1)`
    : `
$roiArea = 1`
}
# Per-pixel luma tolerance. 12 rather than the more common 24 because the thing that
# matters most here is text appearing: anti-aliased glyph edges on a light background
# shift luma by far less than a quarter of the range, and at 24 they vanish entirely.
$tol = 12
$flags = New-Object 'System.Byte[]' ($W * $H)
$diff = 0
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $i = $y * $W + $x
    if ([Math]::Abs([int]$A[$i] - [int]$B[$i]) -gt $tol) {
      $flags[$i] = 1
      $diff++
    }
  }
}
# Second pass: only count changed pixels that touch another changed pixel.
# A caret, a clock tick and dithering are isolated specks; typed text, an opened menu
# and a toggled button are contiguous shapes. Requiring a neighbour is what separates
# "something happened" from "the screen is alive".
$clustered = 0
$local = 0
$sumX = 0
$sumY = 0
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $i = $y * $W + $x
    if ($flags[$i] -eq 0) { continue }
${roi ? `    $inRoi = ($x -ge $roiX1 -and $x -le $roiX2 -and $y -ge $roiY1 -and $y -le $roiY2)` : '    $inRoi = $false'}
    $touching = $false
    if ($x -gt 0 -and $flags[$i - 1] -eq 1) { $touching = $true }
    elseif ($x -lt ($W - 1) -and $flags[$i + 1] -eq 1) { $touching = $true }
    elseif ($y -gt 0 -and $flags[$i - $W] -eq 1) { $touching = $true }
    elseif ($y -lt ($H - 1) -and $flags[$i + $W] -eq 1) { $touching = $true }
    if (-not $touching) { continue }
    $clustered++
    if ($inRoi) { $local++ }
    $sumX += $x
    $sumY += $y
  }
}
$total = $W * $H
$ratio = $clustered / [double]$total
$localRatio = $local / [double]$roiArea
$cx = if ($clustered -gt 0) { [int]($sumX / $clustered) } else { -1 }
$cy = if ($clustered -gt 0) { [int]($sumY / $clustered) } else { -1 }
Write-Output "$ratio|$localRatio|$cx|$cy"
`;
}

/**
 * Turn the numbers into a verdict.
 *
 * Both thresholds are deliberately asymmetric, because the two mistakes are not
 * equally expensive. Saying "nothing happened" when something did costs one extra
 * step. Saying "it worked" when it did not is what produces the click-again loop
 * this whole file exists to break.
 *
 * The numbers below were calibrated by running this against a real desktop: typing
 * ten characters into Notepad moves roughly 0.15% of a 320x180 comparison grid once
 * noise is rejected, and an idle screen moves 0.02%. The gate sits between them with
 * room on both sides. They are a calibration on this machine's screenshots, not a
 * general constant, and `PA_SCREENSHOT_MAX_EDGE` changes them.
 */
export function verdict(
  ratio: number,
  localRatio: number,
  centroidX: number,
  centroidY: number,
  at?: { x: number; y: number },
): FrameDiff {
  // ~35 clustered pixels out of 57600. Lower than this and a blinking caret, which
  // is isolated by construction, would read as a real change.
  const CHANGED = 0.0006;
  // 1% inside the ROI. A control that responds almost always redraws its own box.
  const LOCAL = 0.01;

  if (ratio < CHANGED) {
    return {
      changed: false,
      ratio,
      localRatio,
      movedAway: false,
      verdict:
        'VERIFICACION: la pantalla NO ha cambiado. La accion no ha surtido efecto: ' +
        'el elemento puede estar en otro sitio, tapado, o tus coordenadas estar mal. ' +
        'Haz una captura nueva y busca el elemento en ella en lugar de repetir el clic.',
    };
  }

  if (at && localRatio < LOCAL) {
    return {
      changed: true,
      ratio,
      localRatio,
      movedAway: true,
      verdict:
        `VERIFICACION: la pantalla ha cambiado (${pct(ratio)} de la imagen) pero NADA se movio donde has hecho ` +
        `la accion (${pct(localRatio)}). El cambio esta en (${centroidX},${centroidY}), lejos del punto. ` +
        'Has pulsado el control equivocado o algo detras de la ventana ha reaccionado. ' +
        'Captura de nuevo y localiza el elemento antes de repetir.',
    };
  }

  const near = at ? ` y ${pct(localRatio)} justo en el punto de la accion` : '';
  return {
    changed: true,
    ratio,
    localRatio,
    movedAway: false,
    verdict: `VERIFICACION: la accion ha tenido efecto (${pct(ratio)} de la imagen${near}).`,
  };
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function noChange(reason: string): FrameDiff {
  return {
    changed: false,
    ratio: 0,
    localRatio: 0,
    movedAway: false,
    verdict: `VERIFICACION: ${reason}.`,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
