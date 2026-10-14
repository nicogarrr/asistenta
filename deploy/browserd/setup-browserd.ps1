#requires -Version 5.1
<#
.SYNOPSIS
  Instala y valida el sidecar browserd (Camoufox) en este PC con un comando.

.DESCRIPTION
  Pasos en orden: localiza Python 3.12+, crea/verifica el venv browserd\.venv,
  instala dependencias, descarga el Firefox parcheado (camoufox fetch, solo la
  primera vez) y corre el smoke real (Camoufox + barrera, todo loopback).

  Flags opcionales (se ejecutan DESPUES de la instalacion y en este orden):
    -Start         arranca el sidecar en segundo plano con config explicita
                   (BROWSERD_HOST=127.0.0.1, BROWSERD_PORT=7701, token vacio)
                   y solo lo da por bueno si /health responde el contrato
                   browserd (service=browserd, version, capability 'read').
                   Logs en browserd\logs (sobrescritos en cada arranque).
    -Bench         bateria anti-bot real con la IP de este PC (visita tiendas
                   reales; tarda varios minutos). Resultado:
                   browserd\bench\results.json
    -EnableEngine  ULTIMO paso: escribe BROWSER_ENGINE=camoufox en el .env de
                   la raiz del repo (lo lee asistenta al arrancar via el
                   loader nativo de Node, src/envfile.ts). Solo se ejecuta si
                   todos los pasos anteriores fueron bien; la escritura es
                   atomica (ReplaceFile con backup unico de esta corrida)
                   y transaccional con verificacion: si algo falla se
                   deshace solo lo de esta transaccion y se verifica la
                   restauracion. Este script NO reinicia asistenta.

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

function Test-PythonVersion([string]$exe, [string[]]$cargs) {
  # Devuelve la version "mayor.menor" si es >= 3.12; $null en cualquier otro caso.
  $ver = & $exe @cargs -c "import sys;print(str(sys.version_info[0])+'.'+str(sys.version_info[1]))" 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $ver) { return $null }
  $parts = $ver.Trim().Split('.')
  if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 12)) {
    return $ver.Trim()
  }
  return $null
}

# --- 1. Python 3.12+ -------------------------------------------------------
Step 'Buscando Python 3.12+'
$python = $null
foreach ($candidate in @(@('py', '-3.14'), @('py', '-3.13'), @('py', '-3.12'), @('py', '-3'), @('python'))) {
  $exe = $candidate[0]
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
  $cargs = @()
  if ($candidate.Count -gt 1) { $cargs += $candidate[1] }
  $ver = Test-PythonVersion $exe $cargs
  if ($ver) {
    $python = @{ Exe = $exe; CArgs = $cargs; Version = $ver }
    break
  }
}
if (-not $python) {
  throw "Python 3.12+ no encontrado. Instalalo desde https://www.python.org marcando 'Add python.exe to PATH' y vuelve a correr este script."
}
Write-Host "Python $($python.Version) via $($python.Exe)"

# --- 2. Entorno virtual ----------------------------------------------------
Step 'Verificando el entorno virtual browserd\.venv'
$venvDir = Join-Path $browserdDir '.venv'
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (Test-Path $venvPy) {
  $vver = Test-PythonVersion $venvPy @()
  if (-not $vver) {
    Write-Host 'El venv existente usa Python <3.12 o esta roto: lo recreo.'
    Remove-Item -Recurse -Force $venvDir
  }
}
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

# --- 6. Arranque del sidecar (opcional) -------------------------------------
if ($Start) {
  Step 'Arrancando el sidecar en segundo plano (config explicita 127.0.0.1:7701)'
  $bdHost = '127.0.0.1'
  $bdPort = 7701
  $health = "http://${bdHost}:$bdPort/health"

  function Test-Browserd([string]$url) {
    # Contrato: es browserd, declara version y expone la lectura atomica /read.
    try {
      $h = Invoke-RestMethod -Uri $url -TimeoutSec 3
      return ($h.service -eq 'browserd' -and $h.version -and ($h.capabilities -contains 'read'))
    } catch {
      return $false
    }
  }

  if (Test-Browserd $health) {
    Write-Host 'Ya hay un browserd valido respondiendo en 127.0.0.1:7701; no arranco otro.'
  } else {
    $occupied = $false
    try { Invoke-RestMethod -Uri $health -TimeoutSec 2 | Out-Null; $occupied = $true } catch {}
    if ($occupied) {
      throw '127.0.0.1:7701 responde pero NO es un browserd valido (falta service/version/read en /health). Cierra ese proceso antes de seguir.'
    }

    $logsDir = Join-Path $browserdDir 'logs'
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    $outLog = Join-Path $logsDir 'browserd.out.log'
    $errLog = Join-Path $logsDir 'browserd.err.log'

    # Config explicita para el hijo: nada de heredar sorpresas del entorno.
    $prevHost = $env:BROWSERD_HOST
    $prevPort = $env:BROWSERD_PORT
    $prevToken = $env:BROWSERD_TOKEN
    $env:BROWSERD_HOST = $bdHost
    $env:BROWSERD_PORT = "$bdPort"
    $env:BROWSERD_TOKEN = ''
    try {
      $proc = Start-Process -PassThru -FilePath $venvPy -ArgumentList '-m', 'browserd' -WorkingDirectory $browserdDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    } finally {
      $env:BROWSERD_HOST = $prevHost
      $env:BROWSERD_PORT = $prevPort
      $env:BROWSERD_TOKEN = $prevToken
    }

    $up = $false
    for ($i = 0; $i -lt 30 -and -not $up; $i++) {
      if ($proc.HasExited) { break }
      Start-Sleep -Seconds 1
      if (Test-Browserd $health) { $up = $true }
    }
    if (-not $up) {
      if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
      throw "El sidecar no respondio con el contrato esperado en 30s (proceso salio: $($proc.HasExited)). Revisa $errLog"
    }
    Write-Host "Sidecar arriba y validado (pid $($proc.Id)). Logs: $logsDir"
  }
}

# --- 7. Bateria anti-bot real (opcional) ------------------------------------
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

# --- 8. Flag del motor (opcional, SIEMPRE el ultimo paso) -------------------
if ($EnableEngine) {
  Step 'Escribiendo BROWSER_ENGINE=camoufox en .env (raiz del repo)'
  $envFile = Join-Path $RepoDir '.env'
  # Sintaxis dotenv real: admite "export CLAVE = valor" con espacios; cualquier
  # asignacion previa de BROWSER_ENGINE se elimina y queda exactamente UNA.
  $keyPattern = '^\s*(?:export\s+)?BROWSER_ENGINE\s*='
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

  $hadFile = Test-Path $envFile
  $lines = @()
  if ($hadFile) { $lines = [System.IO.File]::ReadAllLines($envFile) }
  $kept = @($lines | Where-Object { $_ -notmatch $keyPattern })
  $kept += 'BROWSER_ENGINE=camoufox'

  # Backup UNICO por transaccion: nunca se restaura un backup de otra corrida.
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $tmp = "$envFile.browserd-tmp-$stamp-$PID"
  $backup = "$envFile.browserd-bak-$stamp-$PID"
  $mutated = $false

  # Escritura y verificacion en la MISMA transaccion: cualquier fallo (incluido
  # leer de nuevo el archivo) deshace SOLO lo que esta transaccion hizo.
  try {
    [System.IO.File]::WriteAllLines($tmp, [string[]]$kept, $utf8NoBom)
    if ($hadFile) {
      # Reemplazo atomico con backup (Win32 ReplaceFile): tambien en PS5.1. Si
      # Replace lanza, el destino quedo intacto (es atomico), por eso $mutated
      # solo se pone despues de que retorne.
      [System.IO.File]::Replace($tmp, $envFile, $backup)
      $mutated = $true
    } else {
      Move-Item $tmp $envFile
      $mutated = $true
    }
    $final = [System.IO.File]::ReadAllLines($envFile)
    $found = @($final | Where-Object { $_ -match $keyPattern })
    if ($found.Count -ne 1 -or $found[0] -notmatch '=\s*"?camoufox"?\s*$') {
      throw 'la verificacion post-escritura no encontro exactamente una asignacion valida'
    }
  } catch {
    $cause = $_.Exception.Message
    if (-not $mutated) {
      # WriteAllLines o el propio Replace/Move fallaron: ReplaceFile es atomico,
      # asi que el .env original sigue intacto. No hay nada que restaurar.
      throw "No pude escribir .env; la mutacion no llego a aplicarse y el archivo original esta intacto. $cause"
    }
    if ($hadFile) {
      # Restaurar SOLO el backup que Replace acaba de crear en ESTA transaccion.
      if (-not (Test-Path $backup)) {
        throw "La escritura fallo tras mutar .env y NO existe el backup de esta transaccion ($backup). Revisa .env a mano. $cause"
      }
      Copy-Item $backup $envFile -Force -ErrorAction SilentlyContinue
      $restored = $false
      try {
        $h1 = (Get-FileHash $backup -Algorithm SHA256).Hash
        $h2 = (Get-FileHash $envFile -Algorithm SHA256).Hash
        $restored = ($h1 -eq $h2)
      } catch {}
      if (-not $restored) {
        throw "La escritura fallo y ADEMAS no pude confirmar la restauracion desde $backup. Revisa .env a mano. $cause"
      }
      throw "La escritura fallo; .env restaurado y verificado desde el backup de esta corrida ($backup). $cause"
    }
    # No habia .env: deshacer la creacion y comprobarlo.
    Remove-Item $envFile -Force -ErrorAction SilentlyContinue
    if (Test-Path $envFile) {
      throw "La verificacion fallo y no pude borrar el .env que cree en esta corrida; borralo a mano. $cause"
    }
    throw "La verificacion fallo; se deshizo la creacion del .env (no existia antes). $cause"
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Host ".env actualizado (backup de esta corrida: $backup; se puede borrar cuando quieras). Asistenta lo lee al arrancar; este script no la reinicia."
}

Step 'Listo'
Write-Host 'Sidecar instalado y validado (smoke real PASS).'
if (-not $Start) { Write-Host 'Para arrancarlo:  powershell -ExecutionPolicy Bypass -File deploy\browserd\setup-browserd.ps1 -Start' }
if ($EnableEngine) { Write-Host 'Recuerda: BROWSER_ENGINE=camoufox se aplica al reiniciar asistenta (hazlo cuando te venga bien).' }
