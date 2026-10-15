# serve-windows.ps1 — lanzador certificado del serve OpenCode enjaulado (PC Windows de Nico).
# Replica EXACTA de la jaula medida en la VM (oc-serve2): misma imagen, mismos montajes,
# mismo comando. El adaptador (verifyServeIsolation) vuelve a comprobar en cada llamada
# los permisos efectivos y el directory del serve, y aborta fail-closed si no coincide.
# Requiere: Docker Desktop en marcha y `opencode auth login` hecho (escribe auth.json).
param(
  [string]$WorkDir = "$env:USERPROFILE\opencode-serve",
  [string]$AuthJson = "$env:USERPROFILE\.local\share\opencode\auth.json",
  [int]$Port = 4096
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $AuthJson)) { throw "No existe $AuthJson - ejecuta primero: opencode auth login (OpenCode Zen)" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# La config de la jaula y el señuelo benigno se copian desde ESTA carpeta del repo
# (scripts/opencode-local/) para que el despliegue use byte a byte lo auditado.
Copy-Item -Force (Join-Path $PSScriptRoot "opencode.json") (Join-Path $WorkDir "opencode.json")
Copy-Item -Force (Join-Path $PSScriptRoot "LEEME.txt") (Join-Path $WorkDir "LEEME.txt")

docker rm -f asistenta-opencode 2>$null | Out-Null
docker run -d --name asistenta-opencode --restart unless-stopped `
  -p "127.0.0.1:${Port}:4096" `
  -v "${AuthJson}:/root/.local/share/opencode/auth.json:ro" `
  -v "${WorkDir}:/work" `
  -w /work node:22 `
  bash -c "npm i -g opencode-ai --silent && opencode serve --hostname 0.0.0.0 --port 4096"
Write-Host "Serve enjaulado en http://127.0.0.1:${Port} (workdir $WorkDir)."
Write-Host "Valida la jaula con: `$env:OC_SERVE_URL='http://127.0.0.1:${Port}'; python $PSScriptRoot\canary.py"
