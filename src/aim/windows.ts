import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { AimSink } from './engine.js';

/**
 * Ratón de Windows con un PowerShell persistente (user32: SetCursorPos y mouse_event). Sin
 * instalar nada. Protocolo de una línea por orden por stdin:
 *   M x y  mover · D  botón izquierdo abajo · U  arriba · R  clic derecho · S n  rueda (n píxeles)
 * y por stdout la primera línea «W H» con el tamaño de la pantalla principal en píxeles reales.
 * shortcut: solo la pantalla principal; con varias pantallas, mejorar con SM_XVIRTUALSCREEN.
 */
export const WINDOWS_MOUSE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System.Runtime.InteropServices;
public class PaMouse {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, int extra);
}
"@
[PaMouse]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[Console]::Out.WriteLine("$($b.Width) $($b.Height)")
[Console]::Out.Flush()
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $p = $l.Split(' ')
  switch ($p[0]) {
    'M' { [PaMouse]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null }
    'D' { [PaMouse]::mouse_event(0x0002, 0, 0, 0, 0) }
    'U' { [PaMouse]::mouse_event(0x0004, 0, 0, 0, 0) }
    'R' { [PaMouse]::mouse_event(0x0008, 0, 0, 0, 0); [PaMouse]::mouse_event(0x0010, 0, 0, 0, 0) }
    'S' { [PaMouse]::mouse_event(0x0800, 0, 0, [int]$p[1], 0) }
  }
}
`;

export interface WindowsChild {
  stdin: { write(line: string): unknown; end(): unknown };
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): unknown;
  kill(): unknown;
}

export type WindowsSpawn = () => WindowsChild;

const defaultSpawn: WindowsSpawn = () => {
  const encoded = Buffer.from(WINDOWS_MOUSE_SCRIPT, 'utf16le').toString('base64');
  const child: ChildProcessWithoutNullStreams = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true },
  );
  return child as unknown as WindowsChild;
};

/** Un clic de rueda de Windows son 120 unidades; el móvil manda píxeles. */
export const WHEEL_UNITS_PER_PIXEL = 3;

export class WindowsSink implements AimSink {
  readonly absolute = true;
  private readonly child: WindowsChild;
  readonly screen: { w: number; h: number };

  private constructor(child: WindowsChild, screen: { w: number; h: number }) {
    this.child = child;
    this.screen = screen;
  }

  /** Arranca PowerShell y espera «W H». Falla con un mensaje claro si no responde. */
  static async open(
    spawnFn: WindowsSpawn = defaultSpawn,
    timeoutMs = 15_000,
  ): Promise<WindowsSink> {
    const child = spawnFn();
    const screen = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('PowerShell no contestó con el tamaño de la pantalla (¿Windows?).'));
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('No se pudo arrancar PowerShell: esto solo funciona en Windows.'));
      });
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('PowerShell se cerró antes de tiempo.'));
      });
      child.stdout.on('data', (c) => {
        buf += String(c);
        const m = /(\d{3,5}) (\d{3,5})\r?\n/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve({ w: Number(m[1]), h: Number(m[2]) });
        }
      });
    });
    return new WindowsSink(child, screen);
  }

  private send(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }
  moveTo(x: number, y: number): void {
    this.send(`M ${Math.round(x)} ${Math.round(y)}`);
  }
  down(): void {
    this.send('D');
  }
  up(): void {
    this.send('U');
  }
  right(): void {
    this.send('R');
  }
  scroll(dy: number): void {
    const n = Math.round(Math.max(-2000, Math.min(2000, dy)) * WHEEL_UNITS_PER_PIXEL);
    if (n !== 0) this.send(`S ${n}`);
  }
  close(): void {
    try {
      this.child.stdin.end();
    } catch {}
    this.child.kill();
  }
}
