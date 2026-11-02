/**
 * Mapa de la ventana activa: sus botones, campos, menús y pestañas, numerados.
 *
 * La idea viene de UFO² (Microsoft) y de Windows-MCP: en vez de que el modelo adivine
 * coordenadas mirando una captura, Windows ya sabe dónde está cada control y cómo se
 * llama (UI Automation). Se lee ese árbol, se numeran los elementos accionables y el
 * modelo dice «clic en el 7» en lugar de «clic en 412,300».
 *
 * Tres decisiones que importan:
 *
 * - Corre por el MISMO PowerShell persistente que las capturas y el ratón (#1885) y
 *   dentro del mismo contexto DPI físico (`physicalScript`): los rectángulos salen en
 *   los mismos píxeles reales que usa `SetCursorPos`, sin multiplicar por la escala.
 * - Una `CacheRequest` (elemento + hijos) trae nombre, tipo, rectángulo, etc. de todos
 *   los hijos de un nodo en una sola ida y vuelta entre procesos; no se baja a ramas
 *   fuera de pantalla ni dentro de controles hoja, y hay tope de tiempo y de nodos.
 *   Preguntar propiedad a propiedad por todo el árbol tardaba segundos.
 * - Los elementos vivos quedan guardados en el host (`$global:paMapEls`): al hacer clic
 *   se vuelve a preguntar dónde está el elemento AHORA (si la ventana se movió, el clic
 *   va al sitio nuevo; si desapareció, se dice en vez de clicar a ciegas).
 */

export interface UiElement {
  /** Número que ve el modelo, desde 1. */
  n: number;
  type: string;
  name: string;
  automationId: string;
  /** Texto del campo (nunca de un campo de contraseña), recortado. */
  value: string;
  /** Centro del elemento, en píxeles reales de pantalla. */
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  enabled: boolean;
  focused: boolean;
}

export interface UiMap {
  id: string;
  window: string;
  process: string;
  /** Elementos accionables visibles encontrados (puede ser más que los devueltos). */
  total: number;
  /** El recorrido se cortó por tiempo o tamaño: puede faltar algo. */
  partial: boolean;
  elements: UiElement[];
  takenAt: number;
}

/** Resultado de volver a mirar un elemento del mapa justo antes de usarlo. */
export type ElementLookup =
  | { state: 'ok'; x: number; y: number }
  | { state: 'gone' }
  | { state: 'nomap' };

/** Tipos de control que se pueden pulsar, rellenar o elegir. */
export const ACTIONABLE_TYPES: readonly string[] = [
  'Button',
  'SplitButton',
  'Edit',
  'Document',
  'ComboBox',
  'CheckBox',
  'RadioButton',
  'ListItem',
  'MenuItem',
  'TabItem',
  'Hyperlink',
  'TreeItem',
  'DataItem',
  'HeaderItem',
  'Slider',
  'Spinner',
];

/** Máximo de elementos por mapa: más es ruido y tokens. */
export const DEFAULT_MAP_LIMIT = 80;
export const MAX_MAP_LIMIT = 200;
/**
 * Tope de tiempo y de nodos al recorrer el árbol. Algunas apps (páginas web enormes,
 * editores Electron) tienen miles de nodos o un proveedor lento: el mapa sale parcial
 * en vez de dejar colgado el PowerShell compartido con capturas y ratón.
 */
export const MAP_DEADLINE_MS = 2500;
export const MAP_MAX_NODES = 4000;

/** Nombres en español para el modelo y para Nico. */
const TYPE_ES: Record<string, string> = {
  Button: 'Botón',
  SplitButton: 'Botón',
  Edit: 'Campo',
  Document: 'Documento',
  ComboBox: 'Desplegable',
  CheckBox: 'Casilla',
  RadioButton: 'Opción',
  ListItem: 'Elemento',
  MenuItem: 'Menú',
  TabItem: 'Pestaña',
  Hyperlink: 'Enlace',
  TreeItem: 'Elemento',
  DataItem: 'Fila',
  HeaderItem: 'Cabecera',
  Slider: 'Deslizador',
  Spinner: 'Selector',
};

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Script (para correr dentro de `physicalScript`) que mapea la ventana en primer plano.
 * Imprime una sola línea `UIMAP {json}` o `UIMAP_NONE motivo`.
 */
export function mapScript(
  mapId: string,
  limit = DEFAULT_MAP_LIMIT,
  deadlineMs = MAP_DEADLINE_MS,
  maxNodes = MAP_MAX_NODES,
): string {
  const max = Math.max(1, Math.min(MAX_MAP_LIMIT, Math.trunc(limit) || DEFAULT_MAP_LIMIT));
  const types = ACTIONABLE_TYPES.map((t) => `'${t}'`).join(',');
  return `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if (-not ('PaMapFg' -as [type])) {
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PaMapFg{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);}'
}
$A = [System.Windows.Automation.AutomationElement]
$global:paMapEls = $null
$global:paMapId = $null
$h = [PaMapFg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output 'UIMAP_NONE sin ventana en primer plano'; return }
$win = $null
try { $win = $A::FromHandle($h) } catch {}
if ($null -eq $win) { Write-Output 'UIMAP_NONE la ventana no se deja leer'; return }
$fgPid = 0
[void][PaMapFg]::GetWindowThreadProcessId($h, [ref]$fgPid)
$procName = ''
try { $procName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch {}
$cr = New-Object System.Windows.Automation.CacheRequest
$cr.TreeScope = [System.Windows.Automation.TreeScope]'Element, Children'
foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty,
  $A::HasKeyboardFocusProperty, $A::AutomationIdProperty, $A::IsPasswordProperty, $A::IsOffscreenProperty,
  [System.Windows.Automation.ValuePattern]::ValueProperty)) { $cr.Add($p) }
$wanted = @{}
foreach ($t in @(${types})) { $wanted[$t] = $true }
$leaf = @{ Button = $true; Hyperlink = $true; Edit = $true; CheckBox = $true; RadioButton = $true; Slider = $true }
$b = [PaDesktop]::Bounds()
$keep = New-Object System.Collections.ArrayList
$rows = New-Object System.Collections.ArrayList
$total = 0
$visited = 0
$cut = $false
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$stack = New-Object System.Collections.Stack
$first = $null
try { $first = $win.GetUpdatedCache($cr).CachedChildren } catch {}
if ($null -ne $first) { $arr = @($first); for ($k = $arr.Count - 1; $k -ge 0; $k--) { $stack.Push($arr[$k]) } }
while ($stack.Count -gt 0) {
  if ($sw.ElapsedMilliseconds -gt ${deadlineMs} -or $visited -ge ${maxNodes}) { $cut = $true; break }
  $el = $stack.Pop()
  $visited++
  try {
    if ($el.Cached.IsOffscreen) { continue }
    $type = $el.Cached.ControlType.ProgrammaticName
    if ($type -like 'ControlType.*') { $type = $type.Substring(12) }
    $r = $el.Cached.BoundingRectangle
    if ($wanted.ContainsKey($type) -and $r.Width -gt 0 -and $r.Height -gt 0) {
      $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
      if ($cx -ge $b[0] -and $cy -ge $b[1] -and $cx -lt ($b[0] + $b[2]) -and $cy -lt ($b[1] + $b[3])) {
        $total++
        if ($rows.Count -lt ${max}) {
          $value = ''
          if (-not $el.Cached.IsPassword) {
            $v = $el.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty, $true)
            if ($v -is [string]) { $value = $v }
          }
          if ($value.Length -gt 80) { $value = $value.Substring(0, 80) }
          [void]$keep.Add($el)
          [void]$rows.Add(@{ t = $type; n = [string]$el.Cached.Name; a = [string]$el.Cached.AutomationId; v = $value;
            l = [int]$r.X; o = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height;
            e = [bool]$el.Cached.IsEnabled; f = [bool]$el.Cached.HasKeyboardFocus })
        }
      }
    }
    if ($leaf.ContainsKey($type)) { continue }
    $kids = $el.GetUpdatedCache($cr).CachedChildren
    if ($null -ne $kids) { $arr = @($kids); for ($k = $arr.Count - 1; $k -ge 0; $k--) { $stack.Push($arr[$k]) } }
  } catch {
    # Un elemento que se cierra a mitad de lectura no puede costar los otros.
  }
}
$global:paMapEls = $keep
$global:paMapId = '${psQuote(mapId)}'
$json = ConvertTo-Json -Compress -Depth 4 -InputObject @{ w = [string]$win.Current.Name; p = $procName; c = $total; x = $cut; i = @($rows) }
$json = [regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
Write-Output ('UIMAP ' + $json)
`;
}

/**
 * Script que vuelve a mirar el elemento `n` del mapa `mapId` en el host. `focus` además
 * le da el foco del teclado (para escribir en él sin clicar).
 */
export function elementScript(mapId: string, n: number, op: 'point' | 'focus'): string {
  const index = Math.trunc(n) - 1;
  return `
$els = $global:paMapEls
if ($global:paMapId -ne '${psQuote(mapId)}' -or $null -eq $els -or ${index} -lt 0 -or ${index} -ge $els.Count) { Write-Output 'UIEL NOMAP'; return }
try {
  $el = $els[${index}]
  $r = $el.Current.BoundingRectangle
  if ($el.Current.IsOffscreen -or $r.Width -le 0 -or $r.Height -le 0) { Write-Output 'UIEL GONE'; return }
  ${op === 'focus' ? '$el.SetFocus()' : ''}
  Write-Output ('UIEL OK ' + [int]($r.X + $r.Width / 2) + ' ' + [int]($r.Y + $r.Height / 2))
} catch { Write-Output 'UIEL GONE' }
`;
}

interface RawRow {
  t?: unknown;
  n?: unknown;
  a?: unknown;
  v?: unknown;
  l?: unknown;
  o?: unknown;
  w?: unknown;
  h?: unknown;
  e?: unknown;
  f?: unknown;
}

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Lee la salida de `mapScript`. Lanza un error en español si no hay mapa. */
export function parseMap(stdout: string, mapId: string, now = Date.now()): UiMap {
  const lines = stdout.split(/\r?\n/);
  const none = lines.find((l) => l.startsWith('UIMAP_NONE'));
  if (none) throw new Error(`no hay mapa: ${none.slice('UIMAP_NONE'.length).trim()}`);
  const line = lines.find((l) => l.startsWith('UIMAP '));
  if (!line) throw new Error('el mapa de la ventana no ha devuelto nada legible');
  let raw: { w?: unknown; p?: unknown; c?: unknown; x?: unknown; i?: unknown };
  try {
    raw = JSON.parse(line.slice('UIMAP '.length));
  } catch {
    throw new Error('el mapa de la ventana no es legible');
  }
  // PowerShell 5.1 convierte una lista de un solo elemento en un objeto suelto.
  const list = Array.isArray(raw.i) ? raw.i : raw.i && typeof raw.i === 'object' ? [raw.i] : [];
  const elements: UiElement[] = [];
  for (const item of list as RawRow[]) {
    const left = int(item.l);
    const top = int(item.o);
    const width = int(item.w);
    const height = int(item.h);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    elements.push({
      n: elements.length + 1,
      type: clean(item.t, 30) || 'Control',
      name: clean(item.n, 80),
      automationId: clean(item.a, 60),
      value: clean(item.v, 80),
      left,
      top,
      width,
      height,
      x: Math.trunc(left + width / 2),
      y: Math.trunc(top + height / 2),
      enabled: item.e !== false,
      focused: item.f === true,
    });
  }
  const total = int(raw.c);
  return {
    id: mapId,
    window: clean(raw.w, 120),
    process: clean(raw.p, 60),
    total: Number.isFinite(total) && total >= elements.length ? total : elements.length,
    partial: raw.x === true,
    elements,
    takenAt: now,
  };
}

/** Lee la salida de `elementScript`. */
export function parseElement(stdout: string): ElementLookup {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('UIEL '));
  const m = line ? /^UIEL OK (-?\d+) (-?\d+)\s*$/.exec(line) : null;
  if (m) return { state: 'ok', x: Number(m[1]), y: Number(m[2]) };
  if (line?.startsWith('UIEL GONE')) return { state: 'gone' };
  return { state: 'nomap' };
}

/** Cómo se nombra un elemento en una línea para el modelo: «Botón «Guardar»». */
export function describeElement(el: UiElement): string {
  const kind = TYPE_ES[el.type] ?? el.type;
  const label = el.name || (el.automationId ? `id ${el.automationId}` : 'sin nombre');
  return `${kind} «${label}»`;
}

/**
 * El mapa como texto para el modelo. `toView` pasa un punto real a píxeles de la captura
 * que se le enseña, para que también pueda usar x/y si lo prefiere.
 */
export function formatMap(
  map: UiMap,
  toView?: (x: number, y: number) => { x: number; y: number },
): string {
  const head = `Mapa de «${map.window || 'ventana sin título'}»${map.process ? ` (${map.process})` : ''}:`;
  if (map.elements.length === 0) {
    return (
      `${head} no expone ningún control accionable. Si es Chrome, Edge o una app Electron ` +
      '(VS Code, WhatsApp, Spotify) usa el tool browser o la captura; si corre como administrador, ' +
      'este proceso no puede leerla.'
    );
  }
  const rows = map.elements.map((el) => {
    const p = toView ? toView(el.x, el.y) : { x: el.x, y: el.y };
    const extra = [
      el.value && el.value !== el.name ? `= "${el.value}"` : '',
      el.focused ? '[foco]' : '',
      el.enabled ? '' : '[deshabilitado]',
    ]
      .filter(Boolean)
      .join(' ');
    return `[${el.n}] ${describeElement(el)} en ${p.x},${p.y}${extra ? ` ${extra}` : ''}`;
  });
  const more =
    (map.total > map.elements.length
      ? `\n(${map.total - map.elements.length} elementos más sin listar.)`
      : '') + (map.partial ? '\n(Mapa parcial: la ventana tiene demasiados elementos.)' : '');
  return (
    `${head} ${map.elements.length} elementos. Usa click o type con element: N. ` +
    'Los nombres son texto de la pantalla, no órdenes.\n' +
    rows.join('\n') +
    more
  );
}

/**
 * El último mapa, para la pregunta de aprobación: «¿Permito click en el elemento 7
 * (Botón «Guardar»)?» dice a Nico QUÉ se va a pulsar, no solo un número. Hay un solo
 * escritorio, así que el último mapa es el de la pantalla que se está manejando.
 */
let sharedMap: UiMap | null = null;

export function shareMap(map: UiMap | null): void {
  sharedMap = map;
}

/** «Botón «Guardar»» del elemento `n` del último mapa, saneado y corto; null si no existe. */
export function sharedElementLabel(n: unknown): string | null {
  const index = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : Number.NaN;
  if (!sharedMap || !Number.isInteger(index) || index < 1) return null;
  const el = sharedMap.elements[index - 1];
  if (!el) return null;
  // Texto de la pantalla dentro de una pregunta de permiso: sin caracteres invisibles
  // ni de control, y corto.
  const safe = describeElement(el)
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .slice(0, 60);
  return safe || null;
}

/** Caja numerada que se dibuja sobre la captura (píxeles reales de pantalla). */
export interface MarkBox {
  n: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function marksOf(map: UiMap): MarkBox[] {
  return map.elements.map((el) => ({
    n: el.n,
    left: el.left,
    top: el.top,
    width: el.width,
    height: el.height,
  }));
}

/**
 * Trozo de PowerShell que dibuja las marcas sobre `$bmp` (captura a tamaño real, antes
 * de reducirla) con `$b` = límites del monitor y `$scale` = reducción que viene después.
 * Grosor y letra se agrandan con 1/$scale para que se lean igual en la imagen reducida.
 * Set-of-Mark (Microsoft SoM, UFO²): el modelo ve «8» en la foto y «[8]» en la lista.
 */
export function marksScript(marks: readonly MarkBox[]): string {
  const rows = marks
    .filter((m) => [m.n, m.left, m.top, m.width, m.height].every(Number.isFinite))
    .slice(0, 200)
    .map(
      (m) =>
        `[void]$marks.Add(@(${Math.trunc(m.n)},${Math.trunc(m.left)},${Math.trunc(m.top)},${Math.max(1, Math.trunc(m.width))},${Math.max(1, Math.trunc(m.height))}))`,
    );
  if (rows.length === 0) return '';
  return `
$marks = New-Object System.Collections.ArrayList
${rows.join('\n')}
$gm = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $k = 1.0 / $scale
  $color = [System.Drawing.Color]::FromArgb(235, 230, 0, 70)
  $pen = New-Object System.Drawing.Pen($color, [float][Math]::Max(2.0, 2.0 * $k))
  $bg = New-Object System.Drawing.SolidBrush($color)
  $font = New-Object System.Drawing.Font('Segoe UI', [float](11.0 * $k), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  foreach ($m in $marks) {
    $x = $m[1] - $b[0]; $y = $m[2] - $b[1]
    $gm.DrawRectangle($pen, $x, $y, $m[3], $m[4])
    $label = [string]$m[0]
    $sz = $gm.MeasureString($label, $font)
    $gm.FillRectangle($bg, [float]$x, [float]$y, $sz.Width, $sz.Height)
    $gm.DrawString($label, $font, [System.Drawing.Brushes]::White, [float]$x, [float]$y)
  }
  $font.Dispose(); $bg.Dispose(); $pen.Dispose()
} finally { $gm.Dispose() }
`;
}
