/**
 * La pantalla del iPhone desde la ventana de UxPlay (AirPlay → Windows), sin la ESP32 ni
 * el servidor hidagent: se captura esa ventana, se recortan las bandas negras y el JPEG
 * resultante va al OCR de Windows de siempre (src/screen/ocr.ts). Las fracciones que salen
 * del OCR son fracciones de la pantalla del teléfono, las mismas que usa el puntero absoluto.
 *
 * La ruta AirPlay → UxPlay es la de phoneuse (github.com/lxe/phoneuse, MIT); aquí, en
 * Windows y con PowerShell 5.1 + System.Drawing, sin instalar nada más que UxPlay
 * (deploy/iphone/windows/preparar-windows.ps1). Sin probar con un iPhone real.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RecorteVentana {
  /** Rectángulo de la ventana en píxeles físicos. */
  ventana: { x: number; y: number; ancho: number; alto: number };
  /** Lo que queda tras quitar las bandas negras (dentro de la ventana). */
  recorte: { x: number; y: number; ancho: number; alto: number };
}

export class SinVentanaError extends Error {
  constructor() {
    super(
      'No encuentro la ventana de UxPlay: el iPhone no está duplicando la pantalla en este PC (Centro de control > Duplicar pantalla > «Asistenta»). Ver deploy/iphone/windows/GUIA.md.',
    );
  }
}

/** Nombre del proceso de UxPlay en Windows (uxplay.exe). */
export const PROCESO_UXPLAY = 'uxplay';

/**
 * Script de PowerShell 5.1: busca la ventana principal de uxplay.exe (o, si no, una cuyo
 * título contenga «UxPlay»), la captura con PrintWindow (vale aunque esté tapada; si sale
 * en negro, se copia de la pantalla), recorta las bandas negras y guarda un JPEG.
 */
export function scriptCapturaVentana(salida: string): string {
  const ruta = salida.replace(/'/g, "''");
  return `
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) { $env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine') }
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PaUxWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
}
'@
[void][PaUxWin]::SetThreadDpiAwarenessContext([IntPtr](-4))
$h = [IntPtr]::Zero
$p = Get-Process -Name '${PROCESO_UXPLAY}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($p) { $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) {
  $q = Get-Process | Where-Object { $_.MainWindowTitle -like '*UxPlay*' } | Select-Object -First 1
  if ($q) { $h = $q.MainWindowHandle }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'UXPLAY_SIN_VENTANA'; exit 0 }
if ([PaUxWin]::IsIconic($h)) { Write-Output 'UXPLAY_MINIMIZADA'; exit 0 }
$r = New-Object PaUxWin+RECT
[void][PaUxWin]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -lt 50 -or $hh -lt 50) { Write-Output 'UXPLAY_SIN_VENTANA'; exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PaUxWin]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
function EsNegro($c) { return ($c.R + $c.G + $c.B) -lt 48 }
function Vacia($b) {
  for ($i = 1; $i -lt 8; $i++) { if (-not (EsNegro $b.GetPixel([int]($b.Width * $i / 8), [int]($b.Height * $i / 8)))) { return $false } }
  return $true
}
if (-not $ok -or (Vacia $bmp)) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size) }
$g.Dispose()
$cx = [int]($w / 2); $cy = [int]($hh / 2)
$top = 0; while ($top -lt $hh - 1 -and (EsNegro $bmp.GetPixel($cx, $top))) { $top += 2 }
$bot = $hh - 1; while ($bot -gt $top -and (EsNegro $bmp.GetPixel($cx, $bot))) { $bot -= 2 }
$izq = 0; while ($izq -lt $w - 1 -and (EsNegro $bmp.GetPixel($izq, $cy))) { $izq += 2 }
$der = $w - 1; while ($der -gt $izq -and (EsNegro $bmp.GetPixel($der, $cy))) { $der -= 2 }
$cw = $der - $izq + 1; $ch = $bot - $top + 1
if ($cw -lt 50 -or $ch -lt 50) { $izq = 0; $top = 0; $cw = $w; $ch = $hh }
$rect = New-Object System.Drawing.Rectangle $izq, $top, $cw, $ch
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$bmp.Dispose()
$crop.Save('${ruta}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$crop.Dispose()
Write-Output ('UXPLAY_CAPTURA ' + (@{vx=$r.Left;vy=$r.Top;vw=$w;vh=$hh;x=$izq;y=$top;w=$cw;h=$ch} | ConvertTo-Json -Compress))
`;
}

/** Lee la línea `UXPLAY_CAPTURA {...}` del script. Lanza SinVentanaError si no hay ventana. */
export function leerSalidaCaptura(stdout: string): RecorteVentana {
  const lineas = stdout.split(/\r?\n/).map((l) => l.trim());
  if (lineas.includes('UXPLAY_SIN_VENTANA')) throw new SinVentanaError();
  if (lineas.includes('UXPLAY_MINIMIZADA')) {
    throw new Error(
      'La ventana de UxPlay está minimizada: restáurala (no hace falta que esté delante) para poder leer el iPhone.',
    );
  }
  const l = lineas.find((x) => x.startsWith('UXPLAY_CAPTURA '));
  if (!l) throw new Error('La captura de la ventana de UxPlay no devolvió nada legible.');
  const j = JSON.parse(l.slice('UXPLAY_CAPTURA '.length)) as Record<string, number>;
  const n = (k: string) => (Number.isFinite(j[k]) ? Number(j[k]) : 0);
  return {
    ventana: { x: n('vx'), y: n('vy'), ancho: n('vw'), alto: n('vh') },
    recorte: { x: n('x'), y: n('y'), ancho: n('w'), alto: n('h') },
  };
}

export type EjecutarPs = (script: string) => Promise<string>;

const ejecutarPowerShell: EjecutarPs = (script) =>
  new Promise((ok, mal) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err)
          mal(new Error(`La captura de UxPlay falló: ${String(stderr || err).slice(0, 300)}`));
        else ok(stdout);
      },
    );
  });

/** JPEG de la pantalla del iPhone tal como la muestra UxPlay. El temporal se borra siempre. */
export async function capturarVentanaUxplay(
  ejecutar: EjecutarPs = ejecutarPowerShell,
  plataforma: NodeJS.Platform = process.platform,
): Promise<{ jpeg: Buffer; recorte: RecorteVentana }> {
  if (plataforma !== 'win32') {
    throw new Error('Leer la ventana de UxPlay solo funciona en Windows.');
  }
  const ruta = join(
    tmpdir(),
    `asistenta-uxplay-${process.pid}-${randomBytes(4).toString('hex')}.jpg`,
  );
  try {
    const recorte = leerSalidaCaptura(await ejecutar(scriptCapturaVentana(ruta)));
    return { jpeg: await readFile(ruta), recorte };
  } finally {
    await rm(ruta, { force: true });
  }
}
