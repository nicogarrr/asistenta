<#
 Prueba LOCAL y de SOLO LECTURA de Cua Driver (https://cua.ai/docs/cua-driver) en Windows.
 ESTADO: ESCRITO SIN PODER EJECUTARLO (sin Windows ni PowerShell en el entorno que lo preparo).
 Nunca probado. Si algo falla, el script para y lo dice; no reintenta.

 Que hace:
   1. Telemetria desactivada para este proceso ANTES de ejecutar nada de Cua
      (CUA_DRIVER_RS_TELEMETRY_ENABLED=false, DO_NOT_TRACK=1) y luego `telemetry disable`.
   2. Descarga install.ps1 a un FICHERO (no pipe a iex), guarda copia y su SHA256
      para revisarlo, y lo ejecuta con -NoAutoStart -NoPathUpdate.
      OJO: el instalador oficial trae AutoStart ACTIVADO por defecto; aqui se apaga.
   0. Si ya hay un Cua Driver instalado o en marcha, ABORTA sin tocar nada.
   3. Arranca `cua-driver serve` en segundo plano, llama SOLO a health_report,
      get_screen_size y list_windows (sin capturas, sin clics, sin teclado) y para el daemon.
   4. Escribe el resultado completo en un fichero local; por pantalla solo un resumen
      (nº de ventanas, sin titulos). Los titulos de ventana pueden ser privados.
 Que NO hace: no registra tarea programada, no toca PATH, no usa el relay/cloud de Spaces,
 no cambia Telegram, memoria ni permisos de Asistenta, no lee capturas.
 Quitar todo: borrar %USERPROFILE%\.cua-driver y %LOCALAPPDATA%\Programs\Cua.
 Uso (lo ejecuta Asistenta con su aprobacion de comandos):
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\cua-driver-trial.ps1
#>
param([string]$Release = "latest")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 1) telemetria fuera antes de nada
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = "false"
$env:DO_NOT_TRACK = "1"
$env:CUA_TELEMETRY = "0"

$work = Join-Path $env:TEMP ("cua-trial-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $work | Out-Null
$installer = Join-Path $work "install.ps1"
$out = Join-Path $work "resultado.txt"

# 1b) no tocar una instalacion ni un daemon preexistentes
$exe = Join-Path $env:LOCALAPPDATA "Programs\Cua\cua-driver\bin\cua-driver.exe"
if ((Test-Path $exe) -or (Get-Command cua-driver -ErrorAction SilentlyContinue) -or (Get-Process -Name "cua-driver" -ErrorAction SilentlyContinue)) {
  throw "Ya hay un Cua Driver instalado o en marcha: no se toca nada. Revisar a mano."
}

# 2) instalador a fichero, con hash, sin autostart ni PATH
Invoke-WebRequest -UseBasicParsing -Uri "https://cua.ai/driver/install.ps1" -OutFile $installer
$hash = (Get-FileHash -Algorithm SHA256 $installer).Hash
"install.ps1 sha256: $hash" | Tee-Object -FilePath $out
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Release $Release -NoAutoStart -NoPathUpdate
if ($LASTEXITCODE -ne 0) { throw "install.ps1 fallo (exit $LASTEXITCODE)" }

if (-not (Test-Path $exe)) { throw "no encuentro $exe tras instalar" }
& $exe --version | Tee-Object -FilePath $out -Append
& $exe telemetry disable | Tee-Object -FilePath $out -Append
& $exe telemetry status --json | Tee-Object -FilePath $out -Append

# 3) daemon en segundo plano, solo llamadas de lectura
$daemon = Start-Process -FilePath $exe -ArgumentList "serve" -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 5
  "--- health_report" | Add-Content $out
  & $exe call health_report | Add-Content $out
  "--- get_screen_size" | Add-Content $out
  & $exe call get_screen_size | Add-Content $out
  "--- list_windows" | Add-Content $out
  $lw = & $exe call list_windows
  $lw | Add-Content $out
  $n = 0
  try { $n = (($lw -join "`n") | ConvertFrom-Json).windows.Count } catch { $n = -1 }
  "RESUMEN: ventanas visibles=$n (-1 = no pude contarlas)"
} finally {
  # solo se para el daemon que arranco este script (aqui nunca hay uno previo: se aborta arriba)
  if ($daemon -and -not $daemon.HasExited) { Stop-Process -Id $daemon.Id -Force }
}
"Resultado completo (local, puede incluir titulos de ventana): $out"
"Sin autostart, sin cambios de PATH. Telemetria desactivada."
