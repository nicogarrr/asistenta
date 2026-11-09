<#
  Prepara este PC con Windows para manejar el iPhone SIN la ESP32:
    - pantalla: AirPlay del iPhone a la ventana de UxPlay (necesita Bonjour);
    - manos: el Bluetooth del PC como teclado y puntero (ayudante AsistentaHid).
  Comprueba y arregla lo que puede, sin descargar programas por su cuenta. Se puede
  ejecutar las veces que haga falta (idempotente). Lo que necesita permisos de
  administrador (las reglas del cortafuegos) lo dice y sigue con lo demás.

  Uso:
    powershell -ExecutionPolicy Bypass -File preparar-windows.ps1            # comprobar y preparar
    powershell -ExecutionPolicy Bypass -File preparar-windows.ps1 -Arrancar  # además, arrancar UxPlay
    -UxPlay C:\ruta\uxplay.exe   si no está en el PATH ni en %LOCALAPPDATA%\Asistenta\uxplay
#>
param([string]$UxPlay = '', [switch]$Arrancar)
$ErrorActionPreference = 'Stop'
# Desde PowerShell 7 (p. ej. Windows Terminal), `powershell -File` hereda su PSModulePath y
# Windows PowerShell 5.1 no carga sus propios módulos (Get-FileHash, Write-Host...). Se repone.
if ($PSVersionTable.PSVersion.Major -lt 6) { $env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine') }
$fallos = 0
function Bien($t) { Write-Host "[ok]    $t" -ForegroundColor Green }
function Mal($t) { Write-Host "[falta] $t" -ForegroundColor Yellow; $script:fallos++ }

# 1. Bluetooth LE en rol periférico (sin esto no hay teclado ni puntero).
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $null = [Windows.Devices.Bluetooth.BluetoothAdapter, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
  $op = [Windows.Devices.Bluetooth.BluetoothAdapter]::GetDefaultAsync()
  $t = $asTask.MakeGenericMethod([Windows.Devices.Bluetooth.BluetoothAdapter]).Invoke($null, @($op))
  $t.Wait(10000) | Out-Null
  $ad = $t.Result
  if ($null -eq $ad) { Mal 'Este PC no tiene Bluetooth o está apagado (Configuración > Bluetooth).' }
  elseif (-not $ad.IsLowEnergySupported) { Mal 'El Bluetooth de este PC no tiene LE.' }
  elseif (-not $ad.IsPeripheralRoleSupported) { Mal 'El Bluetooth de este PC NO puede hacer de periférico LE: con este adaptador el iPhone no lo verá como teclado. Hace falta otro (p. ej. un USB que diga 5.0 o más y nombre su chip).' }
  else { Bien 'Bluetooth LE con rol periférico.' }
} catch { Mal "No pude preguntar al Bluetooth: $($_.Exception.Message)" }

# 2. El ayudante Bluetooth, compilado con lo que trae Windows.
try { & (Join-Path $PSScriptRoot 'compilar-hid.ps1') | ForEach-Object { Bien $_ } } catch { Mal "Ayudante Bluetooth: $($_.Exception.Message)" }

# 3. Bonjour (UxPlay lo necesita para que el iPhone vea «Asistenta» en Duplicar pantalla).
$bonjour = Get-Service -Name 'Bonjour Service' -ErrorAction SilentlyContinue
if (-not $bonjour) { Mal 'Falta Bonjour: instala «Bonjour Print Services» de Apple (o iTunes) y vuelve a ejecutar esto.' }
elseif ($bonjour.Status -ne 'Running') {
  try { Start-Service 'Bonjour Service'; Bien 'Bonjour arrancado.' } catch { Mal 'Bonjour está instalado pero parado y no pude arrancarlo (prueba como administrador).' }
} else { Bien 'Bonjour en marcha.' }

# 4. UxPlay.
$candidatos = @($UxPlay, (Join-Path $env:LOCALAPPDATA 'Asistenta\uxplay\uxplay.exe')) | Where-Object { $_ }
$enPath = Get-Command uxplay.exe -ErrorAction SilentlyContinue
if ($enPath) { $candidatos += $enPath.Source }
$ux = $candidatos | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ux) { Mal 'No encuentro uxplay.exe. Ver GUIA.md (paso «UxPlay»): compílalo con MSYS2 o usa el paquete uxplay-windows, y deja uxplay.exe en %LOCALAPPDATA%\Asistenta\uxplay\.' }
else { Bien "UxPlay: $ux" }

# 5. Cortafuegos: dejar entrar a UxPlay solo en redes privadas (AirPlay usa TCP y UDP).
if ($ux) {
  $esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  foreach ($proto in 'TCP', 'UDP') {
    $nombre = "Asistenta UxPlay ($proto)"
    $regla = Get-NetFirewallRule -DisplayName $nombre -ErrorAction SilentlyContinue
    if ($regla) { Bien "Cortafuegos: «$nombre» ya existe." }
    elseif ($esAdmin) {
      New-NetFirewallRule -DisplayName $nombre -Direction Inbound -Action Allow -Program $ux -Protocol $proto -Profile Private | Out-Null
      Bien "Cortafuegos: «$nombre» creada (solo red privada)."
    } else { Mal "Cortafuegos: falta «$nombre». Ejecuta esto una vez como administrador." }
  }
  $perfil = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($perfil -and $perfil.NetworkCategory -eq 'Public') { Mal "La red «$($perfil.Name)» está como PÚBLICA: el iPhone no verá el PC. Ponla como privada (Configuración > Red > propiedades)." }
}

if ($Arrancar -and $ux) {
  if (Get-Process -Name uxplay -ErrorAction SilentlyContinue) { Bien 'UxPlay ya está en marcha.' }
  else {
    Start-Process -FilePath $ux -ArgumentList @('-n', 'Asistenta', '-nh') -WindowStyle Normal
    Bien 'UxPlay arrancado como «Asistenta». En el iPhone: Centro de control > Duplicar pantalla > Asistenta.'
  }
}

if ($fallos -eq 0) { Write-Host 'Todo listo. Ahora en el .env de Asistenta: PA_IPHONE_BLE=1 (y reinicia Asistenta).' -ForegroundColor Green }
else { Write-Host "$fallos cosa(s) por arreglar (arriba, en amarillo). Vuelve a ejecutar esto al terminar." -ForegroundColor Yellow; exit 1 }
