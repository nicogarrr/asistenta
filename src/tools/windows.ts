import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { childEnv } from '../child-env.js';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';
import { lastSharedView } from '../screen/ui-map.js';
import { foldAccents } from '../text.js';
import { psErrorSummary } from './ps-error.js';

const execFileAsync = promisify(execFile);

/**
 * Windows windows and UI Automation, with nothing installed.
 *
 * Why this exists, in one line: for a model with mediocre visual grounding, knowing
 * that there is a window called "Untitled - Bloc de notas" and that its Save button
 * is at 214,540 sized 80x24 is worth more than another screenshot. It replaces "click
 * approximately here and hope" with "click the thing that exists", and it also gives
 * the agent the text of a field instead of the pixels of it.
 *
 * Everything here is reached with PowerShell that ships with Windows: `Get-Process`,
 * the `WScript.Shell` COM object for window activation, and `UIAutomationClient` for
 * the control tree. No P/Invoke written by hand.
 *
 * That last point was learned the hard way. A hand-written C# enum-windows helper was
 * the first version and it threw NullReferenceExceptions from inside the callback, and
 * a hand-written P/Invoke block was separately rejected outright by Windows Defender
 * as `ScriptContainedMaliciousContent`. `Get-Process | Where-Object MainWindowTitle`
 * does the same job in one line and cannot fail that way.
 *
 * Two limits are documented rather than hidden, because they decide how this is used:
 *
 * - Chromium and Electron apps expose almost nothing. Their content lives in a
 *   renderer process and is only materialised on request, so a browser window reports
 *   three controls (minimise, maximise, close). For those, the browser tool with a real
 *   DOM is strictly better, and the tool description tells the agent so.
 * - An elevated window cannot be inspected from an unelevated process at all: the tree
 *   comes back empty rather than erroring.
 */
export interface WindowInfo {
  title: string;
  process: string;
  pid: number;
  handle: number;
  focused: boolean;
}

async function ps(script: string, timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env: childEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err: unknown) => {
    log.warn('powershell helper failed', psErrorSummary(err));
    return { stdout: '' };
  });
  return stdout;
}

/**
 * Visible top-level windows.
 *
 * `MainWindowTitle` only reports each process's main window, so secondary dialogs and
 * some tool windows are absent. That is a real gap and it is why this is paired with
 * UI Automation rather than used alone: the tree reaches into dialogs that the process
 * list cannot see.
 */
/** Pid of the process owning the foreground window, or 0. */
async function foregroundPid(): Promise<string> {
  // Minimal single P/Invoke. If Add-Type is unavailable the result is empty and every
  // window just reports focused: false, which is a graceful degradation.
  return ps(`try {
  if (-not ('PaFg' -as [type])) {
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PaFg{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);}'
  }
  $h = [PaFg]::GetForegroundWindow()
  $p = 0
  [PaFg]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  Write-Output $p
} catch { Write-Output 0 }`);
}

export async function listWindows(): Promise<WindowInfo[]> {
  const fgPid = Number((await foregroundPid()).trim()) || 0;
  const rows = await ps(
    `Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle } | ForEach-Object {
  "$($_.ProcessName)|$($_.Id)|$($_.MainWindowHandle)|$($_.MainWindowTitle -replace '[\\r\\n|]', ' ')"
}`,
  );

  const out: WindowInfo[] = [];
  for (const line of rows.split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 4 || !parts[3]) continue;
    const pid = Number(parts[1]);
    out.push({
      process: parts[0] ?? '',
      pid,
      handle: Number(parts[2]) || 0,
      title: parts.slice(3).join('|'),
      focused: fgPid > 0 && pid === fgPid,
    });
  }
  return out;
}

export async function foregroundWindow(): Promise<WindowInfo | null> {
  const windows = await listWindows();
  return windows.find((w) => w.focused) ?? null;
}

/**
 * Bring a window to the front.
 *
 * `WScript.Shell.AppActivate` is used rather than `SetForegroundWindow`: the Win32 call
 * only works for the calling process unless it first attaches to the target's input
 * queue, which is a pile of P/Invoke for something a COM object does in one line. It
 * returns true when it worked and false when Windows refused, which is the signal the
 * caller needs rather than a silent no-op.
 */
/**
 * La ventana que se pide: título exacto, luego título que lo contiene y, si no, el nombre
 * del programa («spotify»: su ventana se titula con la canción que suena). Sin tildes ni
 * mayúsculas a ningún lado: «configuracion» encuentra «Configuración» y al revés. Antes
 * solo valía el título con sus tildes y la respuesta era «no encuentro ninguna ventana».
 */
export function pickWindow(windows: WindowInfo[], match: string): WindowInfo | undefined {
  const norm = (v: string): string =>
    foldAccents(v.normalize('NFC').toLocaleLowerCase('es')).replace(/\s+/g, ' ').trim();
  const needle = norm(match);
  if (!needle) return undefined;
  const procOf = (w: WindowInfo): string => norm(w.process).replace(/\.exe$/, '');
  return (
    windows.find((w) => norm(w.title) === needle) ??
    windows.find((w) => norm(w.title).includes(needle)) ??
    windows.find((w) => procOf(w) === needle.replace(/\.exe$/, '')) ??
    windows.find((w) => needle.length >= 3 && procOf(w).includes(needle))
  );
}

export async function activateWindow(match: string): Promise<{ ok: boolean; title: string }> {
  const windows = await listWindows();
  const target = pickWindow(windows, match);
  if (!target) {
    const names = windows.slice(0, 12).map((w) => w.title);
    throw new Error(
      `no encuentro ninguna ventana con "${match}". Ventanas abiertas: ${names.join(' | ') || '(ninguna)'}`,
    );
  }
  const out = await ps(
    `$ws = New-Object -ComObject WScript.Shell
$ok = $ws.AppActivate(${target.pid})
if ($ok) { Start-Sleep -Milliseconds 250 }
Write-Output $(if ($ok) { 'ok' } else { 'refused' })`,
  );
  return { ok: out.trim() === 'ok', title: target.title };
}

export interface ControlInfo {
  name: string;
  type: string;
  automationId: string;
  /** Centre of the control, in real screen pixels (DPI-corrected). */
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  focused: boolean;
}

/**
 * DPI scale of a window, as a plain multiplier.
 *
 * This is not optional detail. UI Automation reports `BoundingRectangle` in *logical*
 * pixels, while screen capture and `SetCursorPos` use *physical* pixels. On this
 * machine the display runs at 150%, so a button UI Automation places at x=307 is
 * really at x=205 — and clicking 307 lands somewhere in the middle of the screen,
 * past the element entirely. Before this was corrected, every coordinate the tool
 * returned was wrong by exactly the scaling factor.
 *
 * Falls back to 1 when the DPI cannot be read, which keeps the tool usable on a
 * 100% display and fails no worse than before.
 */
export async function dpiScaleFor(handle: number): Promise<number> {
  if (!handle) return 1;
  const out = await ps(`try {
  if (-not ('PaDpi' -as [type])) {
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PaDpi{[DllImport("user32.dll")]public static extern uint GetDpiForWindow(IntPtr h);}'
  }
  $d = [PaDpi]::GetDpiForWindow([IntPtr]${handle})
  Write-Output $(if ($d -gt 0) { $d } else { 96 })
} catch { Write-Output 96 }`);
  const dpi = Number(out.trim()) || 96;
  return dpi > 0 ? dpi / 96 : 1;
}

/**
 * The UI Automation control tree of a window, with exact screen coordinates.
 *
 * This is the "where exactly is the thing" query, and the measurement behind trusting
 * it: on Windows benchmarks, giving a vision model the control tree instead of raw
 * pixels roughly doubled its success rate. For a model whose weak point is emitting
 * coordinates, turning a control into an address is the single cheapest fix available.
 *
 * A note on coordinates: the centre of the rectangle is what the agent should click,
 * not the top-left corner. Clicking a box corner reliably misses on anything narrow.
 */
export async function listControls(
  match?: string,
  limit = 60,
): Promise<{
  window: string;
  visible: number;
  controls: ControlInfo[];
  note: string;
}> {
  // La ventana se busca primero aquí, con pickWindow (sin tildes ni mayúsculas, o por
  // programa: «configuracion» → «Configuración», «spotify» → la canción que suena). El
  // filtro de PowerShell (-like y el nombre exacto de UIA) distingue tildes, y antes
  // «controles de configuracion» acababa en la ventana enfocada o en NOTFOUND.
  const wanted = (match ?? '').trim();
  const windows = wanted ? await listWindows() : null;
  const target = windows ? pickWindow(windows, wanted) : undefined;
  const filter = (target?.title ?? wanted).replace(/'/g, "''");
  const targetHandle = target && Number.isSafeInteger(target.handle) ? target.handle : 0;
  // Resolved here so the script can prefer the window the user is actually looking
  // at, and so the foreground probe is a single PowerShell round trip rather than one
  // per candidate window (listWindows already asked it when there is a match).
  const fgPid = windows
    ? (windows.find((w) => w.focused)?.pid ?? 0)
    : Number((await foregroundPid()).trim()) || 0;
  const script = `
$ErrorActionPreference='Stop'
$PA_FOREGROUND_PID = ${fgPid}
$PaTargetHandle = ${targetHandle}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$win = $null
if ($PaTargetHandle -ne 0) {
  # The window already picked in node (title without accents, or by program name).
  try { $win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$PaTargetHandle) } catch { $win = $null }
}
if ($null -eq $win -and '${filter}' -ne '') {
  # Descendants, not Children: the desktop root's direct children are usually a single
  # unnamed shell pane, and the real windows sit below it. A Children-only lookup finds
  # nothing at all on a session whose shell is arranged that way, which is exactly the
  # kind of "it returned zero results" that gets mistaken for "this app has no tree".
  $byTitle = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, '${filter}')
  $win = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants, $byTitle)
  if ($null -eq $win -or $win.Current.Name -notlike '*${filter}*') {
    $win = $null
  }
}
if ($null -eq $win) {
  # Fall back to a process handle: Get-Process knows the main window handle even when
  # the UIA title does not match exactly, and FromHandle is the most reliable entry
  # point into the tree. With no filter the foreground window wins, because "what
  # controls does the thing I am looking at have" is the question actually being asked;
  # taking the first process with a title would answer it about some random window.
  $candidates = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle }
  $proc = $null
  if ('${filter}' -eq '') {
    $proc = $candidates | Where-Object { $_.Id -eq $PA_FOREGROUND_PID } | Select-Object -First 1
    if ($null -eq $proc) { $proc = $candidates | Select-Object -First 1 }
  } else {
    $proc = $candidates | Where-Object { $_.MainWindowTitle -like ('*${filter}*') } | Select-Object -First 1
  }
  if ($proc) {
    try { $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle) } catch {}
  }
}
if ($null -eq $win) {
  # Last resort: the focused element itself, which exists even when the window above
  # it is not discoverable by title.
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused) {
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $top = $walker.GetParent($focused)
      $win = if ($top) { $top } else { $focused }
    }
  } catch {}
}
if ($null -eq $win) {
  Write-Output 'NOTFOUND||0'
  exit
}
# Announced before enumeration, on purpose. Enumerating a control tree throws on
# individual elements all the time (a window closing mid-walk, a provider that does
# not implement a property), and with $ErrorActionPreference='Stop' the first such
# throw used to abandon the script before it printed anything at all — which surfaced
# as "no windows found" when the window had in fact been located.
Write-Output ("FOUND|" + $win.Current.Name + "|" + $win.Current.NativeWindowHandle)
try {
  $items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $rows = New-Object System.Collections.ArrayList
  $visible = 0
  for ($i = 0; $i -lt $items.Count; $i++) {
    $el = $null
    try {
      $el = $items.Item($i)
      $r = $el.Current.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { continue }
      $visible++
      if ($rows.Count -ge ${limit}) { continue }
      $type = $el.Current.ControlType.ProgrammaticName
      if ($type -like 'ControlType.*') { $type = $type.Substring(12) }
      $name = ($el.Current.Name -replace '[\\r\\n|]', ' ').Trim()
      $rows.Add((@([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2), [int]$r.Width, [int]$r.Height,
        $type, $name, $el.Current.AutomationId,
        $(if ($el.Current.IsEnabled) { '1' } else { '0' }),
        $(if ($el.Current.HasKeyboardFocus) { '1' } else { '0' })) -join '|'))
    } catch {
      # One unreadable element must not cost the other 200.
    }
  }
  Write-Output ("COUNT|" + $visible)
  foreach ($r in $rows) { Write-Output $r }
} catch {
  Write-Output ("ERROR|" + $_.Exception.Message)
}
`;
  const stdout = await ps(script, 25_000);

  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0] ?? '';
  const controls: ControlInfo[] = [];
  let visible = 0;
  let window = '';
  let handle = 0;
  let error = '';
  if (header.startsWith('FOUND|')) {
    const parts = header.split('|');
    window = parts[1] ?? '';
    handle = Number(parts[2]) || 0;
    // Convert from UI Automation's logical pixels to the physical pixels that screen
    // capture and the mouse actually use. Without this every coordinate on a scaled
    // display is wrong by the scale factor, which looks exactly like a model that
    // cannot aim.
    const scale = await dpiScaleFor(handle);
    for (const line of lines.slice(1)) {
      if (line.startsWith('COUNT|')) {
        visible = Number(line.slice(6)) || 0;
        continue;
      }
      if (line.startsWith('ERROR|')) {
        error = line.slice(6);
        continue;
      }
      const p = line.split('|');
      if (p.length < 9) continue;
      controls.push({
        x: Math.round(Number(p[0]) / scale),
        y: Math.round(Number(p[1]) / scale),
        width: Math.round(Number(p[2]) / scale),
        height: Math.round(Number(p[3]) / scale),
        type: p[4] ?? '',
        name: p[5] ?? '',
        automationId: p[6] ?? '',
        enabled: p[7] === '1',
        focused: p[8] === '1',
      });
    }
  }
  const note =
    visible === 0
      ? 'Esta ventana no ha dado controles por UI Automation.' +
        (error ? ` (${error})` : '') +
        ' Si es Chrome, Edge, VS Code, WhatsApp desktop o cualquier app Electron/Chromium, ' +
        'usa el tool browser: su DOM tiene mucha mas informacion que este arbol. Tambien puede ' +
        'pasar si la ventana corre como administrador y este proceso no.'
      : `${visible} controles visibles.`;
  return { window, visible, controls, note };
}

/**
 * Las filas de `controls` con el centro en el espacio de la última captura de `computer`.
 *
 * Antes salían en píxeles reales y el modelo los pasaba a `computer.click`, que entiende
 * píxeles de la captura (1280 px) y los volvía a escalar: en 1920×1080 un botón en
 * 600,400 se clicaba en 900,600. Sin captura previa, píxeles reales, y se dice.
 */
export function controlRows(controls: readonly ControlInfo[]): { rows: string[]; note: string } {
  const v = lastSharedView();
  const toView = (x: number, y: number) =>
    v
      ? {
          x: Math.round((x * v.width) / v.nativeWidth),
          y: Math.round((y * v.height) / v.nativeHeight),
        }
      : { x, y };
  const rows = controls.map((c) => {
    const p = toView(c.x, c.y);
    return (
      `${c.type} "${c.name}" centro ${p.x},${p.y} (${c.width}x${c.height})` +
      `${c.automationId ? ` id=${c.automationId}` : ''}${c.focused ? ' [FOCO]' : ''}` +
      `${c.enabled ? '' : ' [deshabilitado]'}`
    );
  });
  const note = v
    ? `Centros en píxeles de tu última captura (${v.width}x${v.height}), los mismos que usa computer click.`
    : 'Centros en píxeles reales de pantalla: haz antes una captura con computer para clicar con ellos.';
  return { rows, note };
}

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('list'),
      Type.Literal('foreground'),
      Type.Literal('controls'),
      Type.Literal('focus'),
    ]),
    match: Type.Optional(
      Type.String({ description: 'Substring of the window title, for focus and controls.' }),
    ),
    limit: Type.Optional(Type.Number({ description: 'Max controls to return. Default 60.' })),
  }),
);

export function createWindowsTool(): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'windows',
    label: 'Windows',
    description: [
      'Inspect the open windows of this PC and find things to click.',
      '',
      'action=list: every visible window with its title, process and pid.',
      'action=foreground: the window you are looking at right now.',
      'action=controls: the controls of a window, each with its centre in the pixels of',
      'your last computer screenshot (the ones computer click uses) and its type. Even',
      'better: computer screenshot with map: true and click with element: N.',
      'action=focus: bring a window to the front by title.',
      '',
      'Pass match with a piece of the window title to pick which window.',
      'Chromium and Electron apps (Chrome, Edge, VS Code, WhatsApp desktop, Spotify)',
      'report almost nothing here, because their interface is not exposed to Windows.',
      'For those, use the browser tool: it reads the real page. Windows running as',
      'administrator are invisible unless this agent also runs as administrator.',
    ].join(' '),
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'list': {
          const windows = await listWindows();
          if (!windows.length) {
            return {
              content: [{ type: 'text', text: 'No veo ninguna ventana visible con titulo.' }],
              details: { count: 0 },
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: windows
                  .map(
                    (w) => `${w.focused ? '* ' : '  '}"${w.title}" — ${w.process} (pid ${w.pid})`,
                  )
                  .join('\n'),
              },
            ],
            details: { count: windows.length },
          };
        }

        case 'foreground': {
          const fg = await foregroundWindow();
          return {
            content: [
              {
                type: 'text',
                text: fg
                  ? `Ventana activa: "${fg.title}" (${fg.process}, pid ${fg.pid})`
                  : 'No hay ninguna ventana con titulo en primer plano.',
              },
            ],
            details: fg ? { title: fg.title, pid: fg.pid } : {},
          };
        }

        case 'focus': {
          const match = String(args.match ?? '');
          if (!match)
            throw new Error('la accion focus necesita match: parte del titulo de la ventana');
          const res = await activateWindow(match);
          return {
            content: [{ type: 'text', text: `Ventana en primer plano: "${res.title}"` }],
            details: { title: res.title, activated: res.ok },
          };
        }

        case 'controls': {
          const result = await listControls(args.match, Math.trunc(Number(args.limit ?? 60)));
          if (!result.window) {
            return {
              content: [{ type: 'text', text: `No encuentro esa ventana.\n${result.note}` }],
              details: { found: false },
            };
          }
          const { rows, note } = controlRows(result.controls);
          return {
            content: [
              {
                type: 'text',
                text: [`Ventana: "${result.window}"`, `${result.note} ${note}`, '', ...rows].join(
                  '\n',
                ),
              },
            ],
            details: {
              window: result.window,
              visible: result.visible,
              returned: result.controls.length,
            },
          };
        }

        default:
          throw new Error(`accion desconocida: ${String(args.action)}`);
      }
    },
  };
}
