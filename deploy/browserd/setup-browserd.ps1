#requires -Version 5.1
<#
.SYNOPSIS
  Instala y valida el sidecar browserd (Camoufox) en este PC con un comando.

.DESCRIPTION
  Pasos: localiza Python 3.12+, crea el venv browserd\.venv, instala las
  dependencias, descarga el Firefox parcheado (camoufox fetch, solo la
  primera vez) y corre el smoke real (Camoufox + barrera, todo loopback).

  Flags opcionales:
    -Start         arranca el sidecar en segundo plano (logs en browserd\logs)
    -Bench         corre la bateria anti-bot real con la IP de este PC
                   (visita tiendas reales; tarda varios minutos) y deja el
                   resultado en browserd\bench\results.json
    -EnableEngine  escribe BROWSER_ENGINE=camoufox en .env. Surtira efecto en
                   el proximo reinicio de asistenta; este script NO la
                   reinicia ni toca el proceso que este corriendo.

  Estado de verificacion: script revisado estaticamente; su primera ejecucion
  real es en el PC del usuario (Windows). Cada paso falla con mensaje claro.
#>
[CmdletBinding()]
param(
  [switch]$Start,
  [switch]$Bench,
  [switch]$EnableEngine,
  [string]$RepoDir
)

$ErrorActionPreference = 'Stop'

if (-not $RepoDir) {
  $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$browserdDir = Join-Path $RepoDir 'browserd'
if (-not (Test-Path (Join-Path $browserdDir 'requirements.txt'))) {
  throw "No encuentro browserd\requirements.txt bajo $RepoDir. Corre el script dentro del repo de asistenta."
}

function Step([string]$msg) {
  Write-Host ""
  Write-Host "== $msg" -ForegroundColor Cyan
}

# --- 1. Python 3.12+ -------------------------------------------------------
Step 'Buscando Python 3.12+'
$python = $null
foreach ($candidate in @(@('py', '-3.12'), @('python'))) {
  $exe = $candidate[0]
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
  $cargs = @()
  if ($candidate.Count -gt 1) { $cargs += $candidate[1] }
  $ver = & $exe @cargs -c "import sys;print(str(sys.version_info[0])+'.'+str(sys.version_info[1]))" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $ver) { continue }
  $parts = $ver.Trim().Split('.')
  if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 12) {
    $python = @{ Exe = $exe; CArgs = $cargs; Version = $ver.Trim() }
    break
  }
}
if (-not $python) {
  throw "Python 3.12+ no encontrado. Instalalo desde https://www.python.org marcando 'Add python.exe to PATH' y vuelve a correr este script."
}
Write-Host "Python $($python.Version) via $($python.Exe)"

# --- 2. Entorno virtual ----------------------------------------------------
Step 'Creando el entorno virtual browserd\.venv'
$venvDir = Join-Path $browserdDir '.venv'
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  & $python.Exe @($python.CArgs) -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { throw "No pude crear el entorno virtual en $venvDir" }
}

# --- 3. Dependencias -------------------------------------------------------
Step 'Instalando dependencias (pip)'
& $venvPy -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Fallo actualizando pip' }
& $venvPy -m pip install -r (Join-Path $browserdDir 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Fallo instalando requirements.txt' }

# --- 4. Firefox parcheado ---------------------------------------------------
Step 'Descargando el Firefox parcheado (camoufox fetch; solo la primera vez)'
& $venvPy -m camoufox fetch
if ($LASTEXITCODE -ne 0) { throw 'camoufox fetch fallo' }

# --- 5. Smoke real ----------------------------------------------------------
Step 'Smoke real: Camoufox + barrera de red, todo en loopback'
Push-Location $browserdDir
try {
  & $venvPy smoke_read.py
  if ($LASTEXITCODE -ne 0) { throw 'Smoke FAIL: revisa la salida de arriba' }
} finally {
  Pop-Location
}
Write-Host 'Smoke PASS'

# --- 6. Flag del motor (opcional) -------------------------------------------
if ($EnableEngine) {
  Step 'Escribiendo BROWSER_ENGINE=camoufox en .env'
  $envFile = Join-Path $RepoDir '.env'
  $line = 'BROWSER_ENGINE=camoufox'
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  if (Test-Path $envFile) {
    $lines = [System.IO.File]::ReadAllLines($envFile)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match '^BROWSER_ENGINE=') { $lines[$i] = $line; $found = $true }
    }
    if (-not $found) { $lines += $line }
    [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, $utf8NoBom)
  } else {
    [System.IO.File]::WriteAllLines($envFile, [string[]]@($line), $utf8NoBom)
  }
  Write-Host '.env actualizado. Efectivo en el proximo reinicio de asistenta; este script no la reinicia.'
}

# --- 7. Arranque del sidecar (opcional) -------------------------------------
if ($Start) {
  Step 'Arrancando el sidecar en segundo plano (127.0.0.1:7701)'
  $health = 'http://127.0.0.1:7701/health'
  $already = $false
  try { Invoke-RestMethod -Uri $health -TimeoutSec 2 | Out-Null; $already = $true } catch {}
  if ($already) {
    Write-Host 'Ya hay un browserd respondiendo en 127.0.0.1:7701; no arranco otro.'
  } else {
    $logsDir = Join-Path $browserdDir 'logs'
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    $outLog = Join-Path $logsDir 'browserd.out.log'
    $errLog = Join-Path $logsDir 'browserd.err.log'
    Start-Process -FilePath $venvPy -ArgumentList '-m', 'browserd' -WorkingDirectory $browserdDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $up = $false
    for ($i = 0; $i -lt 30 -and -not $up; $i++) {
      Start-Sleep -Seconds 1
      try { Invoke-RestMethod -Uri $health -TimeoutSec 2 | Out-Null; $up = $true } catch {}
    }
    if (-not $up) { throw "El sidecar no respondio en 30s. Revisa $errLog" }
    Write-Host "Sidecar arriba. Logs: $logsDir (sobrescribe en cada arranque)."
  }
}

# --- 8. Bateria anti-bot real (opcional) ------------------------------------
if ($Bench) {
  Step 'Bateria anti-bot real con la IP de este PC (puede tardar varios minutos)'
  Push-Location $browserdDir
  try {
    & $venvPy bench\bench_camoufox.py
    if ($LASTEXITCODE -ne 0) { throw 'La bateria fallo; revisa la salida de arriba' }
  } finally {
    Pop-Location
  }
  Write-Host 'Resultados en browserd\bench\results.json'
}

Step 'Listo'
Write-Host 'Sidecar instalado y validado (smoke real PASS).'
if (-not $Start) { Write-Host 'Para arrancarlo:  powershell -ExecutionPolicy Bypass -File deploy\browserd\setup-browserd.ps1 -Start' }
if ($EnableEngine) { Write-Host 'Recuerda: BROWSER_ENGINE=camoufox se aplica al reiniciar asistenta (hazlo cuando te venga bien).' }
