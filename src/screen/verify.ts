import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';
import { clipRegion, type Region, scaleRegion } from './regions.js';
import { powerShellError, type WindowsScreen } from './windows.js';

const execFileAsync = promisify(execFile);

/** Marker the compare script puts on its one line of output. See `buildCompareScript`. */
const RESULT_PREFIX = 'PA1';
/** Marker every deliberate refusal inside the PowerShell script starts with. */
const REFUSAL_PREFIX = 'pa-frame';

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
 * dependency to answer this question would cost more than the question. Keeping it
 * is defensible because that path was measured, not assumed: it decoded all 221
 * frames the live daemon had captured and answered in 1.4s. What was not defensible
 * was trusting it with an unvalidated buffer and then paraphrasing whatever it
 * complained about, which is where the "out of memory" came from.
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
  /**
   * Set when no comparison was actually performed. The verdict then says the answer is
   * unknown rather than that nothing changed, and callers that can retry should.
   */
  failed?: boolean;
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
  // Checked here, in Node, before anything is written. The decoder is a separate
  // process and its only complaint about a frame with no image in it is
  // "insufficient memory", so an unusable frame used to arrive at it unannounced and
  // come back as a lie: "the screen did not change" for a comparison that never ran.
  const problem =
    frameProblem('captura anterior', before) ?? frameProblem('captura posterior', after);
  if (problem) {
    log.warn('frame compare skipped: the frame is not an image', {
      problem,
      beforeBytes: before.length,
      afterBytes: after.length,
      beforeHead: headBytes(before),
      afterHead: headBytes(after),
    });
    return notCompared(problem);
  }

  const dir = mkdtempSync(join(tmpdir(), 'pa-diff-'));
  const a = join(dir, 'a.jpg');
  const b = join(dir, 'b.jpg');
  try {
    writeFileSync(a, before);
    writeFileSync(b, after);
    // The two frames travel to the decoder as paths, and something else on this
    // machine (%TEMP% is scanned the moment a file appears there) can leave a file
    // whose bytes are not all there yet. Comparing the written length against the
    // buffer catches that before a PowerShell process is spent on it, and names it.
    const writtenA = statSync(a).size;
    const writtenB = statSync(b).size;
    if (writtenA !== before.length || writtenB !== after.length) {
      const problem2 = `no pude escribir las capturas en disco: esperaba ${before.length}/${after.length} bytes y hay ${writtenA}/${writtenB}. Otro proceso esta tocando %TEMP% en este momento.`;
      log.warn('frame compare skipped: the frames did not land intact', {
        problem: problem2,
        beforeBytes: before.length,
        afterBytes: after.length,
        writtenA,
        writtenB,
      });
      return notCompared(problem2);
    }
    return await compareFiles(a, b, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Why this buffer cannot be compared, in one Spanish sentence, or null if it can. */
function frameProblem(label: string, buf: Buffer): string | null {
  if (buf.length === 0) {
    return `la ${label} llego vacia (0 bytes): el backend no devolvio ninguna imagen`;
  }
  // Only the signature is checked here, never the whole file: the decoder is better at
  // this than we are, and it is a separate process that used to answer "insufficient
  // memory" for anything it did not recognise. What is NOT its job is telling us it
  // could not even tell what the bytes are.
  //
  // Several signatures, not just JPEG: `Screenshot.mimeType` is a string and Playwright
  // and a browser screenshot both hand over PNG, which System.Drawing decodes perfectly.
  // Refusing those would have been a regression dressed up as a fix.
  const known = FORMATS.some(
    (magic) => buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic),
  );
  if (!known) {
    return `la ${label} no es una imagen reconocible (${buf.length} bytes, empieza por ${headBytes(buf)}): no tiene la firma de ningun formato de imagen`;
  }
  // A JPEG that stops before its end marker was written incompletely. Comparing it
  // anyway would produce a diff of a half-picture, which is worse than no answer.
  if (
    isJpeg(buf) &&
    (buf.length < 4 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9)
  ) {
    return `la ${label} esta incompleta (${buf.length} bytes, sin el marcador final del JPEG): la captura se corto`;
  }
  return null;
}

/** Signatures System.Drawing decodes. Short on purpose: three bytes tell a PNG from a JPEG from a wall of zeroes, which is the whole question being asked. */
const FORMATS: Buffer[] = [
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0x47, 0x49, 0x46, 0x38]),
  Buffer.from([0x42, 0x4d]),
  Buffer.from([0x49, 0x49, 0x2a]),
  Buffer.from([0x4d, 0x4d]),
];

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** First bytes as hex plus printable ASCII: enough to tell PNG from text from a JPEG. */
function headBytes(buf: Buffer): string {
  const slice = buf.subarray(0, 8);
  const hex = [...slice].map((v) => v.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...slice]
    .map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '.'))
    .join('');
  return `${hex} ("${ascii}")`;
}

/**
 * Refusals the compare script makes on purpose, each with the one sentence the model
 * gets. The token is what PowerShell throws; the detail is bytes, paths and header
 * hex, none of which need translating.
 */
const REFUSALS: Record<string, (detail: string) => string> = {
  'missing-frame': (d) => `no encontre ${d}`,
  'empty-frame': (d) => `${d}: no hay imagen que decodificar`,
  'not-an-image': (d) => `${d}: no tiene la firma de ningun formato de imagen`,
  'truncated-frame': (d) => `${d}: la captura esta a medias`,
  undecodable: (d) => `${d}: ni Node ni System.Drawing la reconocen como una imagen`,
};

/** Pull the refusal out of PowerShell's stderr, if it is one of ours. */
function readRefusal(stderr: string): string | null {
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf(`${REFUSAL_PREFIX}: `);
    if (at < 0) continue;
    const body = line.slice(at + REFUSAL_PREFIX.length + 2);
    const sep = body.indexOf(' | ');
    if (sep < 0) return body;
    const token = body.slice(0, sep);
    const detail = body.slice(sep + 3);
    return REFUSALS[token] ? REFUSALS[token](detail) : detail;
  }
  return null;
}

/** The first line PowerShell printed that is not its own "at line N character 1" furniture. */
function firstRealLine(stderr: string): string | null {
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(En l[ií]nea|At line|\+ CategoryInfo|\s*\+ FullyQualifiedErrorId)/i.test(line)) continue;
    return line;
  }
  return null;
}

export async function compareFiles(
  fileA: string,
  fileB: string,
  options: CompareOptions = {},
): Promise<FrameDiff> {
  if (!existsSync(fileA) || !existsSync(fileB))
    return notCompared('no existe una de las dos capturas en disco');

  let stdout: string;
  try {
    const { stdout: out } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildCompareScript(fileA, fileB, options)],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 20_000 },
    );
    stdout = out;
  } catch (err) {
    const stderr = stderrOf(err);
    const refusal = readRefusal(stderr);
    const reason = refusal ?? firstRealLine(stderr) ?? 'PowerShell termino sin decir por que';
    // `err` alone is unreadable: it carries the whole generated script and a stderr that
    // has already lost its accents to the console code page. The reason is broken out on
    // its own so a grep for it is enough to find the cause.
    log.warn('frame compare failed', { reason, stderr, err: { code: errCode(err) } });
    return notCompared(reason);
  }

  const m = new RegExp(`${RESULT_PREFIX}\\|([\\d.]+)\\|([\\d.]+)\\|(-?\\d+)\\|(-?\\d+)`).exec(
    stdout,
  );
  if (!m)
    return notCompared(
      `PowerShell termino bien pero no devolvio numeros (${JSON.stringify(stdout.slice(0, 120))})`,
    );
  return verdict(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), options.at);
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: unknown };
  return typeof e.stderr === 'string' ? e.stderr : '';
}

function errCode(err: unknown): number | string | undefined {
  const e = err as { code?: unknown };
  return typeof e.code === 'number' || typeof e.code === 'string' ? e.code : undefined;
}

/**
 * The PowerShell that does the actual comparison, as a pure function.
 *
 * Exported so it can be inspected and tested without a screen: the arithmetic lives
 * in PowerShell because System.Drawing is what already decodes our JPEGs, and the
 * first version of this had a bug in exactly the part that is hardest to see from
 * the outside.
 *
 * Two conventions with the Node side. The single line of output is prefixed with
 * `RESULT_PREFIX`, so a decode that produced nothing cannot be mistaken for a diff of
 * zeroes. Every deliberate refusal throws `pa-frame: <token> | <detail>`, which
 * `compareFiles` turns into one specific sentence instead of "the comparison failed".
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
# Every deliberate refusal starts with ${REFUSAL_PREFIX}: and a token, so the caller can
# say WHICH frame was unusable and WHY instead of repeating a generic failure.
#
# These checks exist because of the worst error message in this whole path.
# [System.Drawing.Image]::FromFile reports a file with no decodable image as
# OutOfMemoryException "Memoria insuficiente." — the same text a real out-of-memory
# produces — which sent an entire debugging session after memory on a machine with
# plenty of it. Reading the bytes first turns that shrug into a sentence: this file,
# this many bytes, these first bytes. A file whose writer has not finished also lands
# here, and gets the truncated/short answer rather than the decoder's.
#
# Several signatures, not just JPEG, because \`Screenshot.mimeType\` is a string and
# browser captures arrive as PNG. The decoder is left to do what it is good at.
function Open-Frame([string]$p, [string]$label) {
  if (-not [System.IO.File]::Exists($p)) { throw '${REFUSAL_PREFIX}: missing-frame | la ' + $label + ' no esta en disco (' + $p + ')' }
  $bytes = [System.IO.File]::ReadAllBytes($p)
  $len = $bytes.Length
  if ($len -lt 4) { throw '${REFUSAL_PREFIX}: empty-frame | la ' + $label + ' tiene ' + $len + ' bytes' }
  $head = ''
  for ($i = 0; $i -lt 4; $i++) { $head += $bytes[$i].ToString('x2') + ' ' }
  $head = $head.Trim()
  $known = ($bytes[0] -eq 0xff -and $bytes[1] -eq 0xd8) -or
           ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) -or
           ($bytes[0] -eq 0x47 -and $bytes[1] -eq 0x49) -or
           ($bytes[0] -eq 0x42 -and $bytes[1] -eq 0x4d) -or
           ($bytes[0] -eq 0x49 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x2a) -or
           ($bytes[0] -eq 0x4d -and $bytes[1] -eq 0x4d)
  if (-not $known) {
    throw '${REFUSAL_PREFIX}: not-an-image | la ' + $label + ' tiene ' + $len + ' bytes y empieza por ' + $head
  }
  if ($bytes[0] -eq 0xff -and $bytes[1] -eq 0xd8 -and ($bytes[$len - 2] -ne 0xff -or $bytes[$len - 1] -ne 0xd9)) {
    throw '${REFUSAL_PREFIX}: truncated-frame | la ' + $label + ' tiene ' + $len + ' bytes y le falta el marcador final del JPEG'
  }
  try {
    return [System.Drawing.Image]::FromFile($p)
  } catch {
    throw '${REFUSAL_PREFIX}: undecodable | la ' + $label + ' tiene ' + $len + ' bytes y cabecera ' + $head + ' pero System.Drawing no la decodifico: ' + $_.Exception.Message
  }
}
$probe = Open-Frame '${fileA.replace(/'/g, "''")}' 'captura anterior'
$checkB = Open-Frame '${fileB.replace(/'/g, "''")}' 'captura posterior'
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
$checkB.Dispose()
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
Write-Output "${RESULT_PREFIX}|$ratio|$localRatio|$cx|$cy"
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

/**
 * The verdict for a comparison that never happened.
 *
 * This is deliberately NOT the same sentence as "the screen did not change", because
 * that is the one thing this file must never say when it does not know. Telling the
 * model an action was inert when the diff never ran is the same defect as the
 * `verify()` that used to return null without acting: a false negative that pushes the
 * agent into a retry loop it has no reason to be in. So the shape stays (callers branch
 * on `changed`) and the sentence says plainly that the answer is unknown, names the
 * reason, and tells the model what to do instead of guessing.
 */
export function notCompared(reason: string): FrameDiff {
  return {
    changed: false,
    ratio: 0,
    localRatio: 0,
    movedAway: false,
    failed: true,
    verdict:
      `VERIFICACION: no he podido comparar las capturas, asi que NO se puede saber si la accion ha tenido ` +
      `efecto — no lo tomes como que no ha pasado nada. Motivo: ${reason}. ` +
      'Haz una captura nueva y observa el estado actual antes de decidir si repites la accion.',
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * One captured frame. Structurally identical to what `WindowsScreen.screenshot()`
 * returns (and to `ScreenShot` in tools/computer.ts) so the same buffer can travel
 * from the backend into `compareFrames`/`verifyBatch` without conversion.
 */
export interface Screenshot {
  image: Buffer;
  mimeType: string;
  /** Size of the image as returned to the model. Regions live in this space. */
  width: number;
  height: number;
  /** Real desktop size the frame was taken from, for scaleRegion translations. */
  nativeWidth: number;
  nativeHeight: number;
  /** Set when a requested ROI crop could not be performed and the full frame is returned instead. */
  detail?: string;
}

export interface BatchPair {
  before: Screenshot;
  after: Screenshot;
  /**
   * Where this pair's action was expected to have an effect, in the pixel space
   * of the pair's own frames. Absent means "anywhere counts", which is what an
   * untargeted action like typing deserves.
   */
  roi?: Region;
}

export interface BatchVerdict {
  /** At least one pair changed where it should, and none changed only elsewhere. */
  done: boolean;
  /** One line the model can act on. */
  reason: string;
  /** Pairs that left a footprint inside their own roi (or anywhere, when none given). */
  changed: number;
  total: number;
}

/**
 * One verdict for a whole batch of before/after pairs.
 *
 * The batch tool needs this because N per-action verdict lines is exactly the
 * token traffic the batch exists to remove: the model reads one sentence and
 * decides once whether to proceed or re-observe. Done means "at least one pair
 * changed AND no pair shows a regression", where a regression is a `movedAway`
 * diff — the screen moved, but not under the roi that action was aiming at. A
 * completely inert pair is NOT a regression: some actions (a keypress into an
 * inert field) legitimately do nothing, and failing the whole batch for that
 * would cry wolf once per run.
 */
export async function verifyBatch(pairs: BatchPair[]): Promise<BatchVerdict> {
  if (pairs.length === 0) {
    return {
      done: false,
      reason: 'VERIFICACION: no habia acciones que verificar en el lote.',
      changed: 0,
      total: 0,
    };
  }
  let changed = 0;
  let regressions = 0;
  let uncomparable = 0;
  // The batch's pairs deliberately share the two frames and differ only in the
  // window they watch. Diffing the same bytes twice would pay a PowerShell round
  // trip for an answer already in hand, so equal (frames, window) pairs reuse
  // the first result — `compareFrames` is deterministic for identical inputs.
  const computed: Array<{ before: Buffer; after: Buffer; key: string; diff: FrameDiff }> = [];
  for (const pair of pairs) {
    const options: CompareOptions = {};
    if (pair.roi) {
      // The roi arrives as a rectangle and the comparer wants a point plus a
      // radius: the centre with half the long side covers the same ground while
      // keeping the existing local-diff machinery untouched.
      const roi = pair.roi;
      options.at = { x: roi.x + roi.width / 2, y: roi.y + roi.height / 2 };
      options.radius = Math.max(roi.width, roi.height) / 2;
    }
    const key = options.at
      ? `${options.at.x},${options.at.y},${options.radius ?? ''}`
      : 'whole-frame';
    const cached = computed.find(
      (c) => c.before === pair.before.image && c.after === pair.after.image && c.key === key,
    );
    const diff = cached
      ? cached.diff
      : await compareFrames(pair.before.image, pair.after.image, options);
    if (!cached) {
      computed.push({ before: pair.before.image, after: pair.after.image, key, diff });
    }
    if (diff.changed && !diff.movedAway) changed++;
    if (diff.movedAway) regressions++;
    if (diff.failed) uncomparable++;
  }
  const done = changed >= 1 && regressions === 0;
  return {
    done,
    reason: batchReason(done, changed, regressions, pairs.length, uncomparable),
    changed,
    total: pairs.length,
  };
}

function batchReason(
  done: boolean,
  changed: number,
  regressions: number,
  total: number,
  uncomparable: number,
): string {
  if (regressions > 0) {
    return (
      `VERIFICACION: ${regressions} de ${total} acciones del lote cambiaron la pantalla LEJOS de ` +
      'donde se esperaba: has tocado el control equivocado o algo detras ha reaccionado. ' +
      'Captura de nuevo y localiza los elementos antes de repetir el lote.'
    );
  }
  // Counted before the "nothing happened" line below, because that line is a lie when
  // the comparison never ran: the whole point of `notCompared` is that "I could not
  // look" and "I looked and saw nothing" must never be the same sentence.
  if (uncomparable === total) {
    return (
      `VERIFICACION: no he podido comparar NINGUNA de las ${total} acciones del lote, asi que no se puede ` +
      'saber si han tenido efecto — no lo tomes como que no ha pasado nada. Mira el log del daemon para el ' +
      'motivo exacto (captura vacia, bytes que no son una imagen, o captura incompleta) y captura de nuevo.'
    );
  }
  if (changed === 0 && uncomparable > 0) {
    return (
      `VERIFICACION: de las ${total} acciones del lote, ${total - uncomparable} no dejaron huella y ` +
      `${uncomparable} no se pudieron comparar (fallo al decodificar la captura, no ausencia de cambios). ` +
      'No repitas el lote entero: captura y comprueba el estado actual.'
    );
  }
  if (changed === 0) {
    return (
      `VERIFICACION: la pantalla NO ha cambiado tras el lote (0 de ${total} acciones dejaron ` +
      'huella). No repitas las mismas acciones: captura y busca los elementos de nuevo.'
    );
  }
  if (done) {
    return `VERIFICACION: el lote ha tenido efecto (${changed} de ${total} acciones dejaron huella).`;
  }
  return `VERIFICACION: sin cambios claros en el lote (${changed} de ${total}).`;
}

/**
 * Capture just one region of the screen.
 *
 * `roi` is in the pixel space of the capture the backend returns (the model's
 * screenshot space). The crop deliberately keeps that capture scale instead of
 * resampling: after a ROI screenshot the model's coordinates must keep the SAME
 * scale factor it was using before, or every subsequent click silently shifts.
 * `nativeWidth`/`nativeHeight` carry the region's real desktop size so callers
 * can translate with `scaleRegion` when they need real pixels.
 *
 * There is no native JPEG decoder in Node and this project adds no image
 * dependency, so the crop goes through System.Drawing in PowerShell — the same
 * mechanism `compareFrames` and `captureScript` already rely on. When that is
 * not possible (Defender, session 0, a corrupt frame) the full capture comes
 * back with a `detail` note instead of an exception: a missing crop degrades one
 * screenshot, and a thrown error would kill the whole batch around it.
 */
export async function captureRoi(
  screen: Pick<WindowsScreen, 'screenshot'>,
  roi: Region,
): Promise<Screenshot> {
  let shot: Screenshot;
  try {
    shot = await screen.screenshot();
  } catch (err) {
    log.warn('roi capture failed', { err });
    return {
      image: Buffer.alloc(0),
      mimeType: 'image/jpeg',
      width: 0,
      height: 0,
      nativeWidth: 0,
      nativeHeight: 0,
      detail: `no pude capturar la pantalla para el ROI (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const frame: Region = { x: 0, y: 0, width: shot.width, height: shot.height };
  const crop = clipRegion(roi, frame);
  if (!crop) {
    return {
      ...shot,
      detail: 'el ROI no se pudo recortar: queda fuera de la captura, va la captura completa',
    };
  }
  if (crop.width === frame.width && crop.height === frame.height && crop.x === 0 && crop.y === 0) {
    return shot;
  }

  try {
    const image = await cropJpeg(shot.image, crop);
    // The crop's real desktop size: one scaleRegion call, same maths the click
    // path uses in the other direction.
    const native = scaleRegion(crop, frame, {
      x: 0,
      y: 0,
      width: shot.nativeWidth,
      height: shot.nativeHeight,
    });
    return {
      image,
      mimeType: 'image/jpeg',
      width: crop.width,
      height: crop.height,
      nativeWidth: native.width,
      nativeHeight: native.height,
    };
  } catch (err) {
    log.warn('roi crop failed', { err });
    return {
      ...shot,
      detail: `el ROI no se pudo recortar (${err instanceof Error ? err.message : String(err)}), va la captura completa`,
    };
  }
}

/** execFile timeout for the ROI crop (ms). */
const CROP_TIMEOUT_MS = 20_000;

/** Crop one JPEG rectangle in PowerShell. Throws on failure; the caller degrades. */
async function cropJpeg(input: Buffer, crop: Region): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'pa-crop-'));
  const src = join(dir, 'in.jpg');
  const out = join(dir, 'out.jpg');
  try {
    writeFileSync(src, input);
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', buildCropScript(src, out, crop)],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: CROP_TIMEOUT_MS },
      );
    } catch (err) {
      // execFile's message is `Command failed: powershell.exe … -Command <script>`:
      // kilobytes of script in the `detail` the model reads. Same trimming as the
      // desktop calls (#504): PowerShell's own sentence, or a plain timeout line.
      throw powerShellError(err, CROP_TIMEOUT_MS);
    }
    if (!existsSync(out)) throw new Error('el recorte no generó ningún archivo');
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The PowerShell that performs the crop, as a pure function — same contract as
 * `buildCompareScript`: inspectable and testable without a screen.
 *
 * DrawImage with explicit source/destination rectangles rather than `Bitmap.Clone`
 * because Clone throws on indexed pixel formats that JPEG decoding can produce,
 * and the failure would land in the caller's degrade path for no good reason.
 */
export function buildCropScript(fileIn: string, fileOut: string, crop: Region): string {
  const x = Math.round(crop.x);
  const y = Math.round(crop.y);
  const w = Math.max(1, Math.round(crop.width));
  const h = Math.max(1, Math.round(crop.height));
  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${fileIn.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap ${w}, ${h}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, ${w}, ${h})), (New-Object System.Drawing.Rectangle(${x}, ${y}, ${w}, ${h})), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$src.Dispose()
$bmp.Save('${fileOut.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output 'ok'
`;
}
