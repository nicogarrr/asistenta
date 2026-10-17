/** Native primary-screen geometry and input share physical pixels, never Windows DIPs. */
export const PHYSICAL_DESKTOP = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PaDesktop {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  public static int[] Bounds() {
    MONITORINFO info = new MONITORINFO(); info.Size = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromPoint(new POINT(), 1), ref info)) throw new InvalidOperationException("Primary monitor unavailable");
    return new int[] { info.Monitor.Left, info.Monitor.Top, info.Monitor.Right-info.Monitor.Left, info.Monitor.Bottom-info.Monitor.Top };
  }
}
'@
$physicalContext = [IntPtr](-4)
$previousContext = [PaDesktop]::SetThreadDpiAwarenessContext($physicalContext)
if ($previousContext -eq [IntPtr]::Zero -or -not [PaDesktop]::AreDpiAwarenessContextsEqual([PaDesktop]::GetThreadDpiAwarenessContext(), $physicalContext)) { throw 'No se pudo verificar DPI físico; no se captura ni mueve el cursor.' }
`;

export function physicalScript(script: string): string {
  return `$ErrorActionPreference='Stop'\n${PHYSICAL_DESKTOP}\ntry {\n${script}\n} finally {\n[void][PaDesktop]::SetThreadDpiAwarenessContext($previousContext)\n}`;
}

export interface CaptureGeometry {
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}
export function parseCaptureGeometry(stdout: string): CaptureGeometry {
  const lines = stdout.trim().split(/\r?\n/);
  const line = lines.filter((value) => value.startsWith('PA_CAPTURE '));
  if (line.length !== 1)
    throw new Error('Geometría de captura ausente o ambigua; pide otra captura.');
  const parsed = JSON.parse(line[0]?.slice('PA_CAPTURE '.length) ?? '') as CaptureGeometry;
  const values = [parsed.width, parsed.height, parsed.nativeWidth, parsed.nativeHeight];
  if (
    values.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 32768) ||
    parsed.width > parsed.nativeWidth ||
    parsed.height > parsed.nativeHeight
  ) {
    throw new Error('Geometría de captura inválida; pide otra captura.');
  }
  // Independent rounding can differ by one output pixel, not change aspect ratio.
  if (
    Math.abs(parsed.width / parsed.nativeWidth - parsed.height / parsed.nativeHeight) >
    1 / Math.min(parsed.nativeWidth, parsed.nativeHeight)
  ) {
    throw new Error('Relación de aspecto de captura incoherente.');
  }
  return parsed;
}

/** Read JPEG SOF dimensions instead of guessing from policy or a second process. */
export function jpegGeometry(bytes: Buffer): { width: number; height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Captura no es JPEG.');
  let at = 2;
  const sof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) break;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) break;
    const size = bytes.readUInt16BE(at);
    if (size < 2 || at + size > bytes.length) break;
    if (sof.has(marker) && size >= 8) {
      const height = bytes.readUInt16BE(at + 3);
      const width = bytes.readUInt16BE(at + 5);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    at += size;
  }
  throw new Error('JPEG sin dimensiones verificables.');
}
