<#
 Prueba LOCAL y de SOLO LECTURA de Cua Driver en Windows x64 (https://cua.ai/docs/cua-driver).
 ESTADO: ESCRITO SIN PODER EJECUTARLO (sin Windows ni PowerShell donde se preparo). Nunca probado.
 Si algo falla, el script para y lo dice; no reintenta.

 Diseno (tras la revision del auditor): NO usa el instalador de cua.ai (install.ps1 trae
 migraciones/repair, mata procesos, toca tareas programadas/PATH y descarga un modulo
 _install-common.psm1 mutable sin hash). En su lugar:
   - Descarga el ZIP oficial FIJADO de GitHub Releases (tag cua-driver-rs-v0.37.0) y exige
     que su SHA256 sea el fijado abajo (coincide con SHA256SUMS de la release; el ZIP no esta
     firmado por mi: verificado solo el hash). AVISO: GitHub marca esa release como prerelease.
   - Extrae en una carpeta aislada en %TEMP% (nada en Program Files, PATH, registro ni tareas).
   - Exige Authenticode Valid con firmante "Cua AI, Inc." en cada .exe.
   - Antes de nada ABORTA si ya hay rastro de Cua Driver: tarea cua-driver-serve, procesos
     cua-driver / cua-driver-uia, carpetas %USERPROFILE%\.cua-driver, .cua-driver-rs,
     %LOCALAPPDATA%\Programs\Cua, Programs\trycua, o variables CUA_DRIVER_RS_*.
   - Telemetria desactivada en el entorno antes de ejecutar el exe, y luego `telemetry disable`.
   - Arranca `cua-driver.exe serve` desde la carpeta aislada, llama SOLO a health_report,
     get_screen_size y list_windows (sin capturas, clics ni teclado), para SOLO los procesos
     cuya ruta esta en la carpeta aislada y borra SOLO esa carpeta aislada. Si el exe deja estado en ~\.cua-driver(-rs), NO lo borra: lo avisa.
   - Resultado completo en un fichero local; por pantalla solo un resumen (nº de ventanas,
     sin titulos, que pueden ser privados).
 NO verificado: que `serve` y `call` usen la CLI/canal igual que en Linux, nombres de ficheros
 de estado en Windows y que list_windows devuelva el JSON esperado (el conteo cae a -1 si no).
 Uso (lo ejecuta Asistenta con su aprobacion de comandos):
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\cua-driver-trial.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Tag     = "cua-driver-rs-v0.37.0"
$ZipName = "cua-driver-rs-0.37.0-windows-x86_64.zip"
$ZipUrl  = "https://github.com/trycua/cua/releases/download/$Tag/$ZipName"
$ZipSha  = "109ab57e5c0a6e13a73e2ce2daf01b338027366eb1a20c6e0b413a10610bc8e2"

# 0) preflight: si hay cualquier rastro de Cua Driver, no se toca nada
$traces = @()
if (Get-Process -Name "cua-driver","cua-driver-uia","cua-cursor-theme" -ErrorAction SilentlyContinue) { $traces += "proceso cua-driver*" }
try { if (Get-ScheduledTask -TaskName "cua-driver-serve" -ErrorAction SilentlyContinue) { $traces += "tarea cua-driver-serve" } } catch { }
foreach ($p in @("$env:USERPROFILE\.cua-driver","$env:USERPROFILE\.cua-driver-rs","$env:LOCALAPPDATA\Programs\Cua","$env:LOCALAPPDATA\Programs\trycua")) {
  if (Test-Path $p) { $traces += $p }
}
if (Get-Command cua-driver -ErrorAction SilentlyContinue) { $traces += "cua-driver en PATH" }
Get-ChildItem Env: | Where-Object { $_.Name -like "CUA_DRIVER_RS_*" } | ForEach-Object { $traces += "variable $($_.Name)" }
if ($traces.Count -gt 0) { throw "Ya hay rastro de Cua Driver, no se toca nada: $($traces -join '; ')" }

# 1) telemetria fuera ANTES de ejecutar nada de Cua
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = "false"
$env:DO_NOT_TRACK = "1"
$env:CUA_TELEMETRY = "0"

$work = Join-Path $env:TEMP ("cua-trial-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $work | Out-Null
$zip = Join-Path $work $ZipName
$out = Join-Path $work "resultado.txt"
$bin = Join-Path $work "bin"

# 2) ZIP fijado, hash fijado, firma Authenticode
Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip
$h = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
"zip sha256: $h (esperado $ZipSha)" | Tee-Object -FilePath $out
if ($h -ne $ZipSha) { Remove-Item -LiteralPath $zip -Force; throw "SHA256 del ZIP no coincide con el fijado: no se extrae nada" }
Expand-Archive -LiteralPath $zip -DestinationPath $bin
$exe = Get-ChildItem -LiteralPath $bin -Recurse -Filter "cua-driver.exe" | Select-Object -First 1
if (-not $exe) { throw "no hay cua-driver.exe en el ZIP" }
foreach ($f in Get-ChildItem -LiteralPath $bin -Recurse -File -Filter *.exe) {
  $sig = Get-AuthenticodeSignature -FilePath $f.FullName
  if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch 'CN="?Cua AI, Inc\."?') {
    throw "firma Authenticode no valida o firmante inesperado en $($f.Name): $($sig.Status)"
  }
}
"Authenticode OK (Cua AI, Inc.) en todos los .exe" | Tee-Object -FilePath $out -Append
$exePath = $exe.FullName

& $exePath --version | Tee-Object -FilePath $out -Append
& $exePath telemetry disable | Tee-Object -FilePath $out -Append
& $exePath telemetry status --json | Tee-Object -FilePath $out -Append

# 3) daemon desde la carpeta aislada, solo lectura
$daemon = Start-Process -FilePath $exePath -ArgumentList "serve" -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 5
  "--- health_report" | Add-Content $out
  & $exePath call health_report | Add-Content $out
  "--- get_screen_size" | Add-Content $out
  & $exePath call get_screen_size | Add-Content $out
  "--- list_windows" | Add-Content $out
  $lw = & $exePath call list_windows
  $lw | Add-Content $out
  $n = -1
  try { $n = (($lw -join "`n") | ConvertFrom-Json).windows.Count } catch { $n = -1 }
  "RESUMEN: ventanas visibles=$n (-1 = no pude contarlas)"
} finally {
  # solo procesos lanzados desde la carpeta aislada
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
Remove-Item -LiteralPath $bin -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
"Resultado completo (local, puede incluir titulos de ventana): $out"
# El estado que el exe cree fuera de la carpeta aislada NO se borra (podria haber otro proceso
# usando esas rutas): solo se informa, para que Nico/Asistenta decida.
foreach ($p in @("$env:USERPROFILE\.cua-driver","$env:USERPROFILE\.cua-driver-rs")) {
  if (Test-Path $p) { "AVISO: el exe ha dejado estado en $p (no borrado; revisar a mano)" }
}
"Sin instalador, sin autostart, sin PATH, sin tareas. Telemetria desactivada. Carpeta aislada borrada."
