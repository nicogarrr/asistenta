<#
Compila y graba el firmware de la ESP32-S3 desde WINDOWS (arduino-cli).
NO guarda la contrasena del wifi en ningun sitio salvo el secrets.h local del
clon (el upstream lo ignora en git). La contrasena se pide sin eco.

Requisitos: git y arduino-cli en el PATH, y el core esp32 3.x
(arduino-cli core install esp32:esp32). Placa en blanco: mantener BOOT al
enchufar el USB-C para entrar en el modo de grabacion.

Uso:
  powershell -ExecutionPolicy Bypass -File deploy\iphone\flash.ps1 -WifiSsid "MiWifi" -ServerHost 192.168.1.50 -Port COM5
  -ServerHost = IP LAN del PC que corre el servidor (con WSL2 en modo mirrored es la IP del PC).
#>
param(
  [Parameter(Mandatory = $true)][string]$WifiSsid,
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [Parameter(Mandatory = $true)][string]$Port,
  [string]$Dest = "$HOME\esp32-iphone-agent",
  [int]$ServerPort = 7300
)
$ErrorActionPreference = 'Stop'
$Pin = '88a51030b5ec36564157bc778c7827b4dffb4b41'
$Fqbn = 'esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=cdc,FlashSize=8M'

if ($ServerHost -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw "ServerHost debe ser una IP v4: $ServerHost" }
if ($WifiSsid -match '["\\]') { throw 'El SSID no puede llevar comillas ni barras.' }

if (-not (Test-Path "$Dest\.git")) { git clone https://github.com/onehumanbeing/esp32-iphone-agent $Dest }
git -C $Dest fetch -q origin
git -C $Dest checkout -q $Pin
if ((git -C $Dest rev-parse HEAD).Trim() -ne $Pin) { throw 'El clon no esta en el commit fijado.' }

$sec = Read-Host -AsSecureString 'Contrasena del wifi 2.4 GHz'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if ($pass -match '["\\]') { throw 'La contrasena no puede llevar comillas ni barras (rompe el .h).' }

$sketch = "$Dest\hardware\hid_bridge"
@"
#define WIFI_SSID "$WifiSsid"
#define WIFI_PASS "$pass"
#define SERVER_HOST "$ServerHost"
#define SERVER_PORT $ServerPort
"@ | Set-Content -Encoding ascii "$sketch\secrets.h"
$pass = $null

arduino-cli compile -b $Fqbn --build-property 'compiler.cpp.extra_flags=' --output-dir "$Dest\hardware\build" $sketch
arduino-cli upload -b $Fqbn -p $Port --input-dir "$Dest\hardware\build" $sketch
Write-Host 'Firmware grabado. Desenchufa y enchufa la placa al iPhone.'
