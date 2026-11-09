<#
  Compila el ayudante Bluetooth de Asistenta (AsistentaHid.cs) con el compilador de C# que
  ya trae Windows (.NET Framework 4.x). No descarga ni instala nada.
  Resultado: %LOCALAPPDATA%\Asistenta\iphone\AsistentaHid.exe
  Idempotente: si el código no ha cambiado desde la última compilación, no hace nada.
  Uso: powershell -ExecutionPolicy Bypass -File compilar-hid.ps1 [-Forzar]
#>
param([switch]$Forzar)
$ErrorActionPreference = 'Stop'

$fuente = Join-Path $PSScriptRoot 'AsistentaHid.cs'
$destino = Join-Path $env:LOCALAPPDATA 'Asistenta\iphone'
$exe = Join-Path $destino 'AsistentaHid.exe'
$huella = Join-Path $destino 'AsistentaHid.sha256'

$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'
if (-not (Test-Path $csc)) { throw "No encuentro el compilador de C# de Windows ($csc). Hace falta .NET Framework 4.x (viene con Windows 10/11)." }
foreach ($m in 'Windows.Devices.winmd', 'Windows.Foundation.winmd', 'Windows.Storage.winmd') {
  if (-not (Test-Path (Join-Path $winmd $m))) { throw "Falta $m en ${winmd}: este Windows no trae las APIs de Bluetooth LE (hace falta Windows 10 1703 o posterior)." }
}

New-Item -ItemType Directory -Force -Path $destino | Out-Null
$sha = (Get-FileHash -Algorithm SHA256 $fuente).Hash
if (-not $Forzar -and (Test-Path $exe) -and (Test-Path $huella) -and ((Get-Content $huella -Raw).Trim() -eq $sha)) {
  Write-Output "Ya compilado y al día: $exe"
  exit 0
}

$refs = @(
  (Join-Path $winmd 'Windows.Devices.winmd'),
  (Join-Path $winmd 'Windows.Foundation.winmd'),
  (Join-Path $winmd 'Windows.Storage.winmd'),
  (Join-Path $fw 'System.Runtime.WindowsRuntime.dll'),
  (Join-Path $fw 'System.Runtime.dll'),
  (Join-Path $fw 'System.Threading.Tasks.dll'),
  (Join-Path $fw 'System.Web.Extensions.dll')
)
$argumentos = @('/nologo', '/target:exe', '/platform:anycpu', '/optimize+', "/out:$exe") + ($refs | ForEach-Object { "/reference:$_" }) + @($fuente)
& $csc @argumentos
if ($LASTEXITCODE -ne 0) { throw "La compilación falló (código $LASTEXITCODE). Copia el error de arriba a Asistenta." }
Set-Content -Path $huella -Value $sha -Encoding ASCII
Write-Output "Compilado: $exe"
