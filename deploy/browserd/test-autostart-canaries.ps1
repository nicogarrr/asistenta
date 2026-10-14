#requires -Version 5.1
# Canarios de la logica del autostart de browserd (sin tocar el Planificador).
# Uso: pwsh -File test-autostart-canaries.ps1 ; exit != 0 si falla alguno.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Select-BrowserdProcess.ps1')

$script:fail = 0
function Check([string] $name, [bool] $cond) {
    if ($cond) { Write-Host "PASS $name" } else { Write-Host "FAIL $name"; $script:fail++ }
}

# Modulo exacto: un modulo prefijado NO casa (canario pedido por el auditor).
Check 'modulo exacto casa'          (Test-BrowserdCommandLine '"C:\repo\browserd\.venv\Scripts\python.exe" -m browserd')
Check 'modulo con args extra casa'  (Test-BrowserdCommandLine '"C:\py\python.exe" -m browserd --port 7701')
Check 'prefijado backup NO casa'    (-not (Test-BrowserdCommandLine '"C:\py\python.exe" -m browserd_backup'))
Check 'prefijado extra NO casa'     (-not (Test-BrowserdCommandLine '"C:\py\python.exe" -m browserdextra'))
Check 'otro modulo NO casa'         (-not (Test-BrowserdCommandLine '"C:\py\python.exe" -m http.server 7701'))

# Extraccion del python de la accion registrada (canario de ruta con espacios).
$args1 = '"C:\mi repo\asistenta\deploy\browserd\start-browserd-hidden.vbs" "C:\mi repo\asistenta\browserd\.venv\Scripts\python.exe" "C:\mi repo\asistenta\browserd"'
Check 'python de accion (espacios)' ((Get-LauncherPythonPath $args1) -eq 'C:\mi repo\asistenta\browserd\.venv\Scripts\python.exe')
Check 'sin tokens quoted es null'   ($null -eq (Get-LauncherPythonPath 'sin comillas'))

if ($script:fail -gt 0) { Write-Host "$script:fail canarios FAIL"; exit 1 }
Write-Host 'Todos los canarios PASS'
