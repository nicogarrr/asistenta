import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { log } from '../log.js';
import { withTimeout } from '../utils.js';

const execFileAsync = promisify(execFile);

/**
 * Read the text off an image, with the position of every word, using the OCR engine
 * that already ships inside Windows.
 *
 * Why this exists at all: the vision model driving this agent has mediocre grounding
 * and weak OCR. Text it cannot read is text it cannot click, so a screenshot of a
 * Spanish desktop is to it a field of grey rectangles. This is the engine behind
 * Snipping Tool's "Text actions" — offline, no install, no model download, no
 * per-call cost — and it turns "a button somewhere in the image" into "the button
 * labelled Guardar, at 214,540".
 *
 * Positions are the whole point and are the reason for the whole PowerShell dance
 * below. `OcrResult.Text` alone is worth much less than `OcrWord.BoundingRect` per
 * word: the first is a string the model has to match against pixels it cannot measure,
 * the second is a coordinate it can click on the first try.
 *
 * Everything runs in Windows PowerShell 5.1 (`powershell.exe`) and not in PowerShell 7,
 * and that is not a preference. PowerShell 7 dropped the WinRT type projection, so
 * `[Windows.Media.Ocr.OcrEngine]` does not resolve there at all and the feature is not
 * merely slower — it is absent. If this ever moves to `pwsh`, the OCR is the first
 * thing that will break and it will break as "type not found", not as an error anyone
 * would connect to this file.
 */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLine[];
  /** Every line joined with newlines, for quoting back to the user. */
  text: string;
  /** BCP-47 tag of the recognizer that actually ran, e.g. `es-ES`. */
  language: string;
  /** Size of the image that was OCR'd, which is the space every coordinate is in. */
  width: number;
  height: number;
}

/**
 * Language tags tried in order before falling back to the user's profile languages.
 *
 * Spanish is first on purpose and not by accident: this agent talks to its user in
 * Spanish, so the text on its user's screen is Spanish, and the Windows OCR engine
 * will happily hand back Spanish text recognised as English — accents dropped,
 * `ñ` mangled, sometimes whole words replaced. `TryCreateFromUserProfileLanguages()`
 * alone is not enough on a machine whose display language is not Spanish even when a
 * Spanish recognizer is installed, which is exactly this machine.
 */
const PREFERRED_LANGUAGES = ['es-ES', 'es-419', 'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-US', 'es'];

/**
 * The WinRT async -> .NET Task bridge, shared by both scripts.
 *
 * Windows PowerShell can call the WinRT static methods but cannot `await` them: the
 * results are `IAsyncOperation<T>` with no way to block on them from script. The
 * reflection trick below finds `AsTask` on `System.WindowsRuntimeSystemExtensions` and
 * closes it over the result type, which is the only way to get a result rather than a
 * promise. Compiling this with `Add-Type` against the winmd is not an option: `Add-Type`
 * will not take a `.winmd` as a reference, and the alternative — hand-written P/Invoke —
 * is what got this repo's other helper rejected by Windows Defender as
 * `ScriptContainedMaliciousContent`.
 *
 * `$ErrorActionPreference='Stop'` is required for the try/catch around it to be
 * meaningful: without it a failed WinRT call writes a non-terminating error to stderr,
 * the script carries on with a null, and the failure surfaces much later as "OCR
 * returned no text", which reads like a modelling problem rather than an engine one.
 */
export const WINRT_BRIDGE = `
$ErrorActionPreference='Stop'
# Every WinRT type literal needs the assembly named explicitly. Plain
# [Windows.Storage.StorageFile] throws TypeNotFound here even with
# -AssemblyName loaded, and the failure is raised at parse-of-the-literal time, so the
# message points at the type rather than at anything the caller can act on.
foreach ($t in @('Windows.Media.Ocr.OcrEngine','Windows.Media.Ocr.OcrResult','Windows.Globalization.Language',
  'Windows.Storage.StorageFile','Windows.Storage.Streams.IRandomAccessStream',
  'Windows.Graphics.Imaging.BitmapDecoder','Windows.Graphics.Imaging.SoftwareBitmap')) {
  $null = [Type]::GetType($t + ', Windows.Foundation, ContentType=WindowsRuntime')
  if ($null -eq [Type]::GetType($t + ', Windows.Foundation, ContentType=WindowsRuntime')) {
    Write-Output ('PAOCR!ERR|WINRT|' + (PaB64 $t))
    exit 0
  }
}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$PaAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function PaAwait($op, $type) {
  $task = $PaAsTask.MakeGenericMethod($type).Invoke($null, @($op))
  # Task.Wait wraps every failure in an AggregateException, and its own message is
  # "Se han producido uno o varios errores" — the same text for a missing file, a
  # corrupt file and an unsupported format, and none of them the actual HRESULT. Left
  # un-unwrapped, every one of those three failures reaches the caller as one identical
  # useless sentence, which is why the detail has to be rethrown from the base
  # exception rather than from the wrapper.
  try { $task.Wait(-1) | Out-Null } catch [System.AggregateException] {
    throw $task.Exception.GetBaseException()
  }
  $task.Result
}
function PaB64([string]$s) {
  [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}
`;

/**
 * Pick the recognizer, preferring Spanish.
 *
 * `AvailableRecognizerLanguages` is the list of language *packs* actually installed,
 * not the list of keyboard layouts or display languages, and a tag that is not in it
 * makes `TryCreateFromLanguage` return null rather than raise. So the preference list
 * is intersected with it first, and only then is an engine created — otherwise a
 * machine with no Spanish pack gets a null engine and a message about Spanish when the
 * real problem is that nothing is installed at all.
 */
const ENGINE_SELECTION = `
$PaInstalled = @()
foreach ($l in @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)) {
  $PaInstalled += [string]$l.LanguageTag
}
$PaChosen = ''
foreach ($tag in @(${PREFERRED_LANGUAGES.map((t) => `'${t}'`).join(',')})) {
  foreach ($have in $PaInstalled) {
    if ($have -ieq $tag) { $PaChosen = $have; break }
  }
  if ($PaChosen -ne '') { break }
}
$PaEngine = $null
if ($PaChosen -ne '') {
  $PaEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($PaChosen))
}
if ($null -eq $PaEngine) { $PaEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $PaEngine) {
  Write-Output ('PAOCR!ERR|NO_ENGINE|' + (PaB64 ($PaInstalled -join ', ')))
  exit 0
}
`;

/**
 * The whole OCR run, as a pure function of the image path.
 *
 * Exported for the same reason `buildCompareScript` is: the part that is hardest to get
 * right — reaching into an unprojected WinRT object graph — is invisible from the
 * outside, and a bug there looks exactly like "the screen has no text".
 */
export function buildOcrScript(imagePathB64: string): string {
  return `${WINRT_BRIDGE}
try {
${ENGINE_SELECTION}
  $PaPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${imagePathB64}'))
  $PaFile = PaAwait ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PaPath)) ([Windows.Storage.StorageFile])
  $PaStream = PaAwait ($PaFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $PaDecoder = PaAwait ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($PaStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $PaBitmap = PaAwait ($PaDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $PaMax = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($PaBitmap.PixelWidth -gt $PaMax -or $PaBitmap.PixelHeight -gt $PaMax) {
    Write-Output ('PAOCR!ERR|TOO_BIG|' + (PaB64 ($PaBitmap.PixelWidth.ToString() + 'x' + $PaBitmap.PixelHeight + '|' + $PaMax)))
    exit 0
  }
  $PaResult = PaAwait ($PaEngine.RecognizeAsync($PaBitmap)) ([Windows.Media.Ocr.OcrResult])

  # The result's own collections come back as raw __ComObject and CANNOT be indexed.
  # $result.Lines[0] returns the whole collection, and $line.Words[0].BoundingRect then
  # yields an Object[] that throws "cannot convert System.Object[] to Int32". Only
  # enumeration projects the elements into OcrLine and OcrWord. Iterating instead of
  # indexing is the entire reason this loop is written the way it is.
  $PaLines = @()
  foreach ($PaLine in $PaResult.Lines) {
    $PaWords = @()
    $PaMinX = [double]::MaxValue
    $PaMinY = [double]::MaxValue
    $PaMaxX = [double]::MinValue
    $PaMaxY = [double]::MinValue
    foreach ($PaWord in $PaLine.Words) {
      $PaR = $PaWord.BoundingRect
      $PaW = [int][Math]::Round($PaR.Width)
      $PaH = [int][Math]::Round($PaR.Height)
      # A zero-area box is what the engine emits for a speck it decided was a
      # character; it can never be clicked, and it drags the line box towards zero.
      if ($PaW -le 0 -or $PaH -le 0) { continue }
      $PaX = [int][Math]::Round($PaR.X)
      $PaY = [int][Math]::Round($PaR.Y)
      $PaWords += [ordered]@{ text = [string]$PaWord.Text; x = $PaX; y = $PaY; width = $PaW; height = $PaH }
      if ($PaX -lt $PaMinX) { $PaMinX = $PaX }
      if ($PaY -lt $PaMinY) { $PaMinY = $PaY }
      if (($PaX + $PaW) -gt $PaMaxX) { $PaMaxX = $PaX + $PaW }
      if (($PaY + $PaH) -gt $PaMaxY) { $PaMaxY = $PaY + $PaH }
    }
    if ($PaWords.Count -eq 0) { continue }
    $PaText = [string]$PaLine.Text
    if ($PaText.Trim() -eq '') { $PaText = (($PaWords | ForEach-Object { $_.text }) -join ' ') }
    $PaLines += [ordered]@{
      text = $PaText
      x = [int]$PaMinX
      y = [int]$PaMinY
      width = [int]($PaMaxX - $PaMinX)
      height = [int]($PaMaxY - $PaMinY)
      words = @($PaWords)
    }
  }
  $PaOut = [ordered]@{
    language = [string]$PaEngine.RecognizerLanguage.LanguageTag
    width = [int]$PaBitmap.PixelWidth
    height = [int]$PaBitmap.PixelHeight
    lines = @($PaLines)
  }
  $PaOut['text'] = (($PaLines | ForEach-Object { $_.text }) -join [Environment]::NewLine)
  Write-Output ('PAOCR!OK|' + (PaB64 (ConvertTo-Json -InputObject $PaOut -Depth 8 -Compress)))
} catch {
  Write-Output ('PAOCR!ERR|FAILED|' + (PaB64 ([string]$_.Exception.GetType().Name + ': ' + [string]$_.Exception.Message)))
}
`;
}

/** Languages script, as a pure function so it can be inspected without an image. */
export function buildLanguagesScript(): string {
  return `${WINRT_BRIDGE}
try {
${ENGINE_SELECTION}
  Write-Output ('PAOCR!LANGS|' + (PaB64 ($PaInstalled -join ', ')) + '|' + (PaB64 ([string]$PaEngine.RecognizerLanguage.LanguageTag)))
} catch {
  Write-Output ('PAOCR!ERR|FAILED|' + (PaB64 ([string]$_.Exception.Message)))
}
`;
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

/**
 * Run a script and return stdout and stderr.
 *
 * A non-zero exit is not treated as a failure here: the scripts above report their own
 * problems on stdout as `PAOCR!ERR|...` and then `exit 0` precisely so that a Spanish
 * message can be produced from a known cause instead of from an exit code. What this
 * wrapper does catch is the process failing to start or being killed, which is a
 * different failure with a different fix.
 *
 * `powershell.exe` is invoked by name rather than by absolute path for the same reason
 * the rest of the repo does it: the path to 5.1 differs per install and it is on PATH
 * everywhere. The distinguishing detail is that it must be 5.1 — see the file header.
 */
export async function ps(
  script: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const run = execFileAsync('powershell.exe', [...PS_ARGS, script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  }).then(
    (r) => ({ stdout: r.stdout, stderr: r.stderr }),
    // A non-zero exit is left to the caller: execFile's error carries the whole command
    // line, and logging that would put a 5kB PowerShell script into the log file on
    // every OCR miss. Only the tail of stderr is worth anything here.
    (err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }),
  );
  return withTimeout(run, timeoutMs + 2_000, `powershell.exe no ha respondido en ${timeoutMs}ms`);
}

/** The single most useful line of a broken script, with newlines collapsed. */
export function firstStderrLine(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 240) : '';
}

export function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function unb64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * Every failure gets a message the model or the user can act on.
 *
 * The raw .NET exception survives only in the default branch, collapsed to a single
 * capped line. A full COM dump is what this replaces: the real ones read
 * "Exception from HRESULT: 0x80073D54\nat OcrEngine.RecognizeAsync\n..." and tell
 * nobody that the fix is to install a language pack.
 */
function explain(code: string, detail: string): string {
  switch (code) {
    case 'WINRT':
      return (
        'el OCR de Windows no esta disponible en esta sesion: no se ha podido cargar ' +
        (detail || 'Windows.Media.Ocr') +
        '. Es tipico de Windows Server, de una sesion sin escritorio o de un Windows recortado.'
      );
    case 'NO_ENGINE':
      return (
        'no hay ningun motor de OCR instalado en Windows para ningun idioma' +
        (detail ? ` (instalados: ${detail})` : '') +
        '. Anadelo en Ajustes > Hora e idioma > Idioma > Opciones > "Optical character recognition", ' +
        'normalmente el paquete de espanol (Español - España) o el de ingles.'
      );
    case 'TOO_BIG': {
      const [size, max] = detail.split('|');
      return (
        `la imagen es de ${size} y el motor de OCR de Windows acepta como mucho ${max} pixeles por lado. ` +
        'Haz la captura mas pequena (PA_SCREENSHOT_MAX_EDGE) o recorta la zona que te interesa.'
      );
    }
    default:
      return `el OCR de Windows ha fallado sin explicacion util: ${detail.replace(/\s+/g, ' ').slice(0, 300)}`;
  }
}

function isMissingImage(detail: string): boolean {
  return /FileNotFound|DirectoryNotFound|0x80070002|0x80070005/i.test(detail);
}

/**
 * An image Windows could open but not decode.
 *
 * Matched on the HRESULT rather than the message, because the message is localised: the
 * same failure reads "El formato de imagen es desconocido" here and "The image format is
 * unknown" on an English install, and a Spanish-only pattern would have passed on this
 * machine and failed on the next one. `0x88982Fxx` is the whole WINCODEC image-format
 * range and covers empty files, plain text renamed to `.png` and truncated headers,
 * which all surface as the same "I could not read this picture" from the agent's side.
 */
function isUndecodable(detail: string): boolean {
  return /0x88982F|BadImageFormat|WINCODEC|Corrupt|0x80070057/i.test(detail);
}

/**
 * Read the text off an image file.
 *
 * Coordinates are in the image's own pixel space, which is the same space the model was
 * shown the screenshot in, so a position can be passed straight to a click without any
 * scaling. Rejected for being missing or undecodable rather than returning an empty
 * result, because "there is no text here" and "I could not open the picture" lead the
 * model to opposite next steps and the second one is unrecoverable from the outside.
 */
export async function ocrImage(imagePath: string): Promise<OcrResult> {
  if (!existsSync(imagePath)) {
    throw new Error(`no encuentro la imagen para hacer OCR: ${imagePath}`);
  }

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await ps(buildOcrScript(b64(imagePath)), 30_000));
  } catch (err) {
    log.warn('ocr powershell failed', { err });
    throw new Error(
      `no he podido ejecutar el OCR de Windows: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The marker is `PAOCR!<KIND>|...`, so the tag is the text *before* the first pipe
  // and everything after it is positional. Splitting the whole line and reading
  // `parts[1]` as the kind looks equivalent and is not: the tag and the kind are joined
  // by `!`, not by `|`, which is what made an early version of this read the payload as
  // the status and report "respuesta inesperada" for a run that had in fact succeeded.
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PAOCR!'));
  if (!line) {
    // No marker at all means the script never got as far as its own reporting, so this
    // is a fault in the script or in the host rather than in the OCR. The first line of
    // stderr is the parse error, and swallowing it would make every such bug look like
    // "the screen had no text".
    const why = firstStderrLine(stderr);
    log.warn('ocr produced no marker', { stderr: why });
    throw new Error(
      'el OCR de Windows no ha devuelto nada utilizable' +
        (why ? `: ${why}` : '') +
        '. Suele ser una sesion sin escritorio, o un Windows sin la API Windows.Media.Ocr.',
    );
  }

  const cut = line.indexOf('|');
  const tag = line.slice(0, cut);
  const fields = line.slice(cut + 1).split('|');
  if (tag === 'PAOCR!OK') {
    return JSON.parse(unb64(fields[0] ?? '')) as OcrResult;
  }
  if (tag === 'PAOCR!ERR') {
    const code = fields[0] ?? 'FAILED';
    const detail = unb64(fields[1] ?? '');
    if (code === 'FAILED') {
      if (isMissingImage(detail)) {
        throw new Error(
          `no he podido abrir la imagen para el OCR: no existe o no hay permiso (${imagePath}).`,
        );
      }
      if (isUndecodable(detail)) {
        throw new Error(
          'no he podido decodificar la imagen: Windows solo lee aqui PNG, JPEG, BMP, TIFF, GIF y HEIF, ' +
            'y un fichero vacio o a medio escribir cuenta como eso.',
        );
      }
    }
    throw new Error(explain(code, detail));
  }
  throw new Error(`respuesta inesperada del OCR de Windows: ${line.slice(0, 200)}`);
}

/**
 * Render the OCR result as something the model can act on.
 *
 * One line per OCR line, each with its vertical position and the exact point to click.
 * The click point is the centre of the line's box and it is given as a ready-made
 * coordinate, not as a box for the model to do arithmetic on: this model's failure mode
 * is emitting a plausible-looking number, and asking it to average two numbers is
 * asking for exactly that.
 *
 * `maxLines` and `maxChars` exist because a dense screen can produce 200 lines of text
 * for ~8k tokens, and spending the whole step budget on a text dump leaves nothing to
 * act with. Truncation is always stated, and never silently: a truncated list that looks
 * complete is worse than no list, because the model concludes the button is not on
 * screen and closes the wrong dialog.
 */
export function formatOcr(
  result: OcrResult,
  opts: { maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = Math.max(1, Math.trunc(opts.maxLines ?? 120));
  const maxChars = Math.max(120, Math.trunc(opts.maxChars ?? 6_000));
  const header =
    `OCR ${result.width}x${result.height} (motor ${result.language || 'desconocido'}): ` +
    `${result.lines.length} lineas de texto.\n` +
    'Cada linea: y=posicion vertical "texto" (clic x,y). El punto de clic es el centro del ' +
    'texto: usalo tal cual en la accion click del tool computer, sin escalarlo.\n';

  if (result.lines.length === 0) {
    return (
      header +
      'No ha salido texto de esta imagen. O no hay texto legible, o es una app que dibuja la interfaz ' +
      'sin texto real (Canvas, WebGL, un video). Prueba con el tool windows para ver el arbol de controles.'
    );
  }

  const shown = result.lines.slice(0, maxLines);
  const rows = shown.map((line) => {
    const text = line.text.replace(/\s+/g, ' ').trim();
    const cx = Math.round(line.x + line.width / 2);
    const cy = Math.round(line.y + line.height / 2);
    return `y=${line.y} "${text}" (clic ${cx},${cy})`;
  });

  const notices: string[] = [];
  if (result.lines.length > shown.length) {
    const hidden = result.lines.length - shown.length;
    notices.push(
      `ATENCIÓN: hay ${hidden} lineas mas que NO se muestran (limite ${maxLines}). ` +
        'El texto que buscas puede estar entre las omitidas: acota la ventana o haz scroll antes de concluir que no esta.',
    );
  }

  const body = notices.length ? `${rows.join('\n')}\n${notices.join('\n')}` : rows.join('\n');
  if (body.length <= maxChars) return `${header}\n${body}`;

  // Cut on a line boundary when one is close enough, so the last line is never a
  // half-word that the model might read as real content.
  const cut = body.lastIndexOf('\n', maxChars);
  const kept = cut > maxChars * 0.5 ? body.slice(0, cut) : body.slice(0, maxChars);
  const note = `\nSALTO: la salida superaba ${maxChars} caracteres y esta cortada aqui; falta texto por debajo.`;
  return `${header}\n${kept}${note}`;
}

/**
 * Language tags with an OCR recognizer actually installed.
 *
 * This is the list of language *packs*, which is not the same as the list of installed
 * display languages or keyboard layouts, and it is the single most common reason the
 * agent sees nothing: Spanish needs its pack installed even on a machine set to
 * Spanish everywhere else. Reporting the real list is what makes that diagnosable.
 */
export async function availableLanguages(): Promise<string[]> {
  try {
    const { stdout } = await ps(buildLanguagesScript(), 20_000);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PAOCR!LANGS|'));
    if (!line) return [];
    const fields = line.slice(line.indexOf('|') + 1).split('|');
    return unb64(fields[0] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  } catch (err) {
    log.warn('ocr language probe failed', { err });
    return [];
  }
}

/**
 * Whether OCR can run at all. Never throws.
 *
 * The caller uses this to decide whether to offer the tool or to explain itself, and a
 * throw here would turn "this machine cannot OCR" into an unhandled tool error in the
 * middle of a turn — the worst possible moment to learn it.
 */
export async function ocrAvailable(): Promise<boolean> {
  try {
    const { stdout } = await ps(buildLanguagesScript(), 20_000);
    return stdout.split(/\r?\n/).some((l) => l.startsWith('PAOCR!LANGS|'));
  } catch (err) {
    log.warn('ocr availability probe failed', { err });
    return false;
  }
}
