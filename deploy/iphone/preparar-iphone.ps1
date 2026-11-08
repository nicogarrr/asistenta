<#
Asistente guiado «Preparar iPhone» (esp32-iphone-agent). Doble clic en preparar-iphone.bat.
Todo gratis. Pregunta antes de cada paso. Las claves y la contrasena del wifi se piden
SIN ECO en esta ventana: no se imprimen, no van a chat ni a ningun fichero del repo.
Sin probar con un iPhone real. Se puede repetir: salta lo que ya esta hecho.
#>
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Preguntar([string]$t) {
  $r = Read-Host "$t (s/n)"
  return ($r -match '^[sSyY]')
}
function Paso([string]$t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }

Paso '1/6  WSL2 (el servidor del iPhone corre dentro de Ubuntu)'
$distros = (& wsl.exe -l -q 2>$null) -join ' '
if ($distros -notmatch 'Ubuntu') {
  Write-Host 'No encuentro Ubuntu en WSL.'
  Write-Host 'Hace falta abrir esta ventana como administrador (clic derecho en el .bat > Ejecutar como administrador) y reiniciar el PC al acabar.'
  if (Preguntar 'Instalo WSL con Ubuntu ahora') {
    & wsl.exe --install -d Ubuntu
    Write-Host 'Reinicia el PC, abre Ubuntu una vez para crear tu usuario y vuelve a ejecutar este asistente.'
    return
  }
  Write-Host 'Sin WSL no puedo seguir. Hasta otra.'
  return
}
$cfg = Join-Path $HOME '.wslconfig'
if (-not ((Test-Path $cfg) -and (Select-String -Path $cfg -Pattern 'networkingMode\s*=\s*mirrored' -Quiet))) {
  Write-Host 'Para que el iPhone encuentre el servidor hace falta networkingMode=mirrored (Windows 11 22H2 o posterior).'
  if (Preguntar 'Lo anado a .wslconfig (guardo copia .bak)') {
    if (Test-Path $cfg) { Copy-Item $cfg "$cfg.bak" -Force }
    $txt = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { '' }
    if ($txt -match '\[wsl2\]') { $txt = $txt -replace '\[wsl2\]', "[wsl2]`r`nnetworkingMode=mirrored" }
    else { $txt = $txt + "`r`n[wsl2]`r`nnetworkingMode=mirrored`r`n" }
    Set-Content -Path $cfg -Value $txt -Encoding ascii
    & wsl.exe --shutdown
    Write-Host 'Hecho. WSL reiniciado.'
  }
}

Paso '2/6  Servidor en Ubuntu (UxPlay + hidagent)'
$repo = (Resolve-Path (Join-Path $Here '..\..')).Path
$wslRepo = (& wsl.exe -d Ubuntu -- wslpath -a ($repo -replace '\\', '/')).Trim()
if (Preguntar 'Instalo el servidor (te pedira la contrasena de Ubuntu para sudo)') {
  & wsl.exe -d Ubuntu -- bash "$wslRepo/deploy/iphone/install-wsl.sh"
  if ($LASTEXITCODE -ne 0) { throw 'La instalacion en Ubuntu fallo. Copia el mensaje de arriba.' }
}

Paso '3/6  Clave gratis de Gemini (el modelo que mira la pantalla)'
Write-Host 'Se abre la pagina de Google AI Studio: crea una clave gratis (cuenta Google) y copiala.'
if (Preguntar 'Abro la pagina y te pido la clave sin eco') {
  Start-Process 'https://aistudio.google.com/apikey'
  $sec = Read-Host -AsSecureString 'Pega la clave (no se ve) y pulsa Intro'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $key | & wsl.exe -d Ubuntu -- bash "$wslRepo/deploy/iphone/set-key.sh"
  $key = $null
}

Paso '4/6  Firmware de la ESP32-S3 (compilar y grabar)'
Write-Host 'Enchufa la placa al PC por USB-C. Si no la detecta, manten pulsado BOOT mientras la enchufas.'
if (Preguntar 'Grabo la placa ahora') {
  if (-not (Get-Command arduino-cli -ErrorAction SilentlyContinue)) {
    if (Preguntar 'Falta arduino-cli. Lo instalo con winget (gratis)') {
      & winget install --id ArduinoSA.CLI -e --accept-source-agreements --accept-package-agreements
      Write-Host 'Cierra esta ventana y vuelve a ejecutar el asistente para que Windows vea arduino-cli.'
      return
    }
  } else {
    & arduino-cli core install esp32:esp32
    $ssidDet = ''
    try { $ssidDet = ((netsh wlan show interfaces) -match '^\s+SSID\s+:\s+(.+)$' | Select-Object -First 1) -replace '^\s+SSID\s+:\s+', '' } catch {}
    $ssid = Read-Host "Nombre de tu wifi 2.4 GHz [$ssidDet]"
    if (-not $ssid) { $ssid = $ssidDet }
    $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null } | Select-Object -First 1).IPv4Address.IPAddress
    $ipIn = Read-Host "IP de este PC en tu red [$ip]"
    if ($ipIn) { $ip = $ipIn }
    $com = (Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\(COM\d+\)' -and $_.PNPDeviceID -match 'VID_303A' } | Select-Object -First 1).Name
    $port = ''
    if ($com -match '\((COM\d+)\)') { $port = $Matches[1] }
    $portIn = Read-Host "Puerto de la placa [$port]"
    if ($portIn) { $port = $portIn }
    if (-not ($ssid -and $ip -and $port)) { throw 'Falta wifi, IP o puerto. Vuelve a ejecutar.' }
    Write-Host 'Ahora te pedira la contrasena del wifi (sin eco).'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here 'flash.ps1') -WifiSsid $ssid -ServerHost $ip -Port $port
  }
}

Paso '5/6  Pasos que solo puedes hacer tu en el iPhone'
Write-Host '- Ajustes > Accesibilidad > Tocar > AssistiveTouch: activado.'
Write-Host '- Enchufa la placa al iPhone (el iPhone 13 es Lightning: adaptador de Lightning a USB de camara; USB-C directo en el 15 o posterior).'

Paso '6/6  Arrancar'
Write-Host 'Cuando la placa este en el iPhone, en Ubuntu: bash deploy/iphone/run.sh'
Write-Host 'Luego, en el iPhone: Centro de control > Duplicar pantalla > iPhone Agent, y calibra en http://localhost:8890 (Manual controls > Calibrate).'
if (Preguntar 'Arranco el servidor ahora en esta ventana') {
  & wsl.exe -d Ubuntu -- bash "$wslRepo/deploy/iphone/run.sh"
}
