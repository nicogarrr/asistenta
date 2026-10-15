# serve-windows.ps1 — lanzador verificado del serve OpenCode enjaulado (PC Windows de Nico).
# Versiones FIJADAS a lo medido en la VM (2026-10-15): imagen node por digest y
# opencode-ai 1.19.0. Tras arrancar VERIFICA el despliegue real con docker inspect
# (montajes exactos, puerto loopback, sin privileged, sin docker socket) y health
# (GET /config), y falla con exit 1 si algo no coincide. El adaptador
# (verifyServeIsolation) vuelve a comprobar permisos y directory en cada llamada.
# Requiere: Docker Desktop en marcha y `opencode auth login` hecho.
param(
  [string]$WorkDir = "$env:USERPROFILE\opencode-serve",
  [string]$AuthJson = "$env:USERPROFILE\.local\share\opencode\auth.json",
  [int]$Port = 4096
)
$ErrorActionPreference = "Stop"
$NodeImage = "node@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8"
$OpencodeVersion = "1.19.0"

function Fail($msg) { Write-Host "FALLO: $msg"; exit 1 }

if (-not (Test-Path $AuthJson)) { Fail "no existe $AuthJson - ejecuta primero: opencode auth login (OpenCode Zen)" }
if ((Get-Item $AuthJson).LinkType) { Fail "$AuthJson es un symlink/enlace: el auth debe ser un archivo regular" }

# Workdir dedicado y limpio: solo la config de la jaula y el señuelo benigno.
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "opencode.json") (Join-Path $WorkDir "opencode.json")
Copy-Item -Force (Join-Path $PSScriptRoot "LEEME.txt") (Join-Path $WorkDir "LEEME.txt")
$extra = Get-ChildItem $WorkDir | Where-Object { $_.Name -notin @("opencode.json", "LEEME.txt") }
if ($extra) { Fail "el workdir $WorkDir contiene ficheros ajenos a la jaula: $($extra.Name -join ', '). Usa un workdir dedicado vacio." }
if ((Get-Item (Join-Path $WorkDir "LEEME.txt")).LinkType) { Fail "LEEME.txt es un symlink: debe ser un archivo regular benigno" }

docker rm -f asistenta-opencode 2>$null | Out-Null
$cid = docker run -d --name asistenta-opencode --restart unless-stopped `
  -p "127.0.0.1:${Port}:4096" `
  -v "${AuthJson}:/root/.local/share/opencode/auth.json:ro" `
  -v "${WorkDir}:/work" `
  -w /work $NodeImage `
  bash -c "npm i -g opencode-ai@$OpencodeVersion --silent && opencode serve --hostname 0.0.0.0 --port 4096"
if ($LASTEXITCODE -ne 0 -or -not $cid) { Fail "docker run devolvio exit $LASTEXITCODE" }

# Health: el serve tarda en instalar opencode la primera vez; espera acotada.
$ok = $false
foreach ($i in 1..40) {
  Start-Sleep -Seconds 3
  try {
    $cfg = Invoke-RestMethod -Uri "http://127.0.0.1:${Port}/config" -TimeoutSec 5
    if ($cfg.permission) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { Fail "el serve no respondio /config en 120s; revisa: docker logs asistenta-opencode" }

# Verificacion del despliegue REAL (docker inspect), no solo del comando emitido.
$insp = docker inspect asistenta-opencode | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { Fail "docker inspect fallo" }
$h = $insp[0].HostConfig
if ($h.Privileged) { Fail "contenedor privileged" }
$mounts = @($insp[0].Mounts | ForEach-Object { "$($_.Source)->$($_.Destination):rw=$($_.RW)" })
$authExpect = "$((Resolve-Path $AuthJson).Path)->/root/.local/share/opencode/auth.json:rw=False"
$workExpect = "$((Resolve-Path $WorkDir).Path)->/work:rw=True"
if ($mounts -notcontains $authExpect) { Fail "montaje auth.json no es el esperado (RO, archivo). Efectivos: $($mounts -join ' | ')" }
if ($mounts -notcontains $workExpect) { Fail "montaje /work no es el esperado. Efectivos: $($mounts -join ' | ')" }
if ($mounts.Count -ne 2) { Fail "hay montajes inesperados: $($mounts -join ' | ')" }
$pb = $insp[0].HostConfig.PortBindings."4096/tcp"
if (-not $pb -or $pb[0].HostIp -ne "127.0.0.1" -or $pb[0].HostPort -ne "$Port") { Fail "puerto no es loopback puro: $($pb | ConvertTo-Json -Compress)" }
if ($insp[0].Config.Image -ne $NodeImage) { Fail "imagen distinta a la fijada: $($insp[0].Config.Image)" }

Write-Host "Serve enjaulado y VERIFICADO en http://127.0.0.1:${Port} (opencode $OpencodeVersion, imagen fijada por digest)."
Write-Host "Valida la jaula con: python $PSScriptRoot\canary.py"
