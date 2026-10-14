#requires -Version 5.1
<#
.SYNOPSIS
    Registra (o quita) el arranque automatico del sidecar browserd en el
    Planificador de tareas de Windows.

.DESCRIPTION
    browserd tiene que estar escuchando en 127.0.0.1:7701 antes de que asistenta
    le pida una lectura, lo que incluye volver solo tras un reinicio. Este script
    registra una tarea con disparador AtLogOn que arranca
    `browserd\.venv\Scripts\python.exe -m browserd` a traves del launcher oculto
    start-browserd-hidden.vbs (sin ventana de consola, config explicita).

    Es el mismo molde que deploy\windows\install-autostart.ps1 (daemon pa), con
    las tres decisiones heredadas:

    1. Task Scheduler y no la clave Run del registro: una tarea es un objeto con
       disparador, reintentos, historial y codigo de ultimo resultado, visible en
       taskschd.msc. Una entrada Run es una linea de texto que nadie puede ver.
    2. Carpeta de tareas del propio usuario con -RunLevel Limited: no hace falta
       elevacion. El sidecar trabaja para la sesion del usuario y no necesita
       nada del sistema.
    3. La tarea reinicia el proceso solo si SALE (RestartCount 999, cada minuto).
       Un browserd vivo pero colgado parece sano para el Planificador; ese caso
       lo detecta asistenta por el contrato de /health, no esta tarea.

.PARAMETER Uninstall
    Para y borra la tarea. Borrar una tarea que no existe no es un error.

.PARAMETER Status
    Informa si la tarea existe, ultima ejecucion y resultado, y sondea /health.
    Solo lectura.

.PARAMETER TaskName
    Nombre de la tarea. Por defecto `browserd-sidecar`.

.PARAMETER RepoDir
    Raiz del repo (la carpeta que contiene browserd\). Por defecto, el padre del
    padre de la carpeta de este script.

.PARAMETER PythonExe
    Ruta al python del venv. Por defecto browserd\.venv\Scripts\python.exe.

.PARAMETER Force
    Reemplaza una tarea existente con el mismo nombre en vez de negarse.

.PARAMETER Start
    Arranca la tarea nada mas registrarla y valida el contrato de /health,
    en vez de esperar al proximo inicio de sesion.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\browserd\install-browserd-autostart.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\browserd\install-browserd-autostart.ps1 -Start

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\browserd\install-browserd-autostart.ps1 -Status
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [switch] $Uninstall,
    [switch] $Status,
    [switch] $Start,
    [switch] $Force,
    [string] $TaskName = 'browserd-sidecar',
    [string] $RepoDir,
    [string] $PythonExe
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "==> $Message" }
function Write-Ok { param([string] $Message) Write-Host "  ok  $Message" -ForegroundColor Green }
function Write-Bad { param([string] $Message) Write-Host "  !!  $Message" -ForegroundColor Red }

# El sidecar pertenece al usuario que lo instala: su sesion, su IP residencial,
# sus perfiles de navegador. Nada de SYSTEM ni de otros usuarios.
$UserId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { "$env:COMPUTERNAME\$env:USERNAME" }
$TaskPath = "\$UserId\"

$HealthUrl = 'http://127.0.0.1:7701/health'

function Resolve-Repo {
    param([string] $Explicit)
    if ($Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    # deploy\browserd\install-browserd-autostart.ps1 -> deploy\browserd -> deploy -> raiz
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

function Resolve-Python {
    param([string] $Explicit, [string] $BrowserdDir)
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) {
            throw "No existe el python indicado: $Explicit"
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $venvPy = Join-Path $BrowserdDir '.venv\Scripts\python.exe'
    # Fallar aqui y no en cada logon: una tarea que falla en silencio en cada
    # arranque es mucho peor que una que se niega a crearse.
    if (-not (Test-Path -LiteralPath $venvPy -PathType Leaf)) {
        throw "No encuentro $venvPy. Instala el sidecar primero: deploy\browserd\setup-browserd.ps1"
    }
    return $venvPy
}

function Test-Browserd {
    # Contrato: es browserd, declara version y expone la lectura atomica /read.
    try {
        $h = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 3
        return ($h.service -eq 'browserd' -and $h.version -and ($h.capabilities -contains 'read'))
    } catch {
        return $false
    }
}

function Stop-BrowserdProcesses {
    param([string] $PythonExe)
    # Stop-ScheduledTask mata el proceso supervisado (wscript); el python que
    # queda huerfano seguiria ocupando 127.0.0.1:7701 y la siguiente instancia
    # no podria ni arrancar ni notarse. Se mata SOLO el python de ESTE venv
    # corriendo `-m browserd`: filtrar por CommandLine solo podria llevarse por
    # delante un browserd de otra instalacion.
    $escaped = [regex]::Escape($PythonExe)
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $PythonExe -and $_.CommandLine -match '-m\s+browserd' } |
        ForEach-Object {
            Write-Step "Parando browserd huerfano (pid $($_.ProcessId))"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

function Get-Task {
    # SilentlyContinue: "existe?" tiene por respuesta $null, no una excepcion.
    Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Show-Status {
    $task = Get-Task
    if (-not $task) {
        Write-Bad "No hay ninguna tarea llamada '$TaskName' en '$TaskPath'."
        Write-Host "     Instálala con: install-browserd-autostart.ps1"
        return $false
    }
    $info = Get-ScheduledTaskInfo -InputObject $task -ErrorAction SilentlyContinue
    Write-Host "Tarea        : $TaskName"
    Write-Host "Ruta         : $TaskPath"
    Write-Host "Estado       : $($task.State)"
    Write-Host "Ejecuta como : $UserId (RunLevel Limited)"
    foreach ($action in $task.Actions) {
        Write-Host "Orden        : $($action.Execute) $($action.Arguments)"
    }
    foreach ($trigger in $task.Triggers) {
        Write-Host "Disparador   : $($trigger.CimClass.CimClassName)"
    }
    Write-Host "Última       : $($info.LastRunTime) · resultado 0x$('{0:X}' -f [int]$info.LastTaskResult)"
    Write-Host "Siguiente    : $($info.NextRunTime)"
    Write-Host "Reinicios    : $($task.Settings.RestartCount) cada $($task.Settings.RestartInterval)"
    if ($info.LastTaskResult -ne 0 -and $null -ne $info.LastRunTime) {
        Write-Bad 'La última ejecución terminó con error. Mira browserd\logs\browserd.err.log.'
    }
    if (Test-Browserd) {
        Write-Ok "browserd responde con su contrato en $HealthUrl"
    } else {
        Write-Host "Health       : browserd NO responde ahora mismo en $HealthUrl (puede no estar arrancado)"
    }
    return $true
}

function Uninstall {
    $task = Get-Task
    if (-not $task) {
        Write-Ok "No hay ninguna tarea llamada '$TaskName'. Nada que hacer."
        return
    }
    Write-Step "Parando y borrando '$TaskName'"
    Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
    $repo = Resolve-Repo -Explicit $RepoDir
    $py = Join-Path $repo 'browserd\.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $py -PathType Leaf) { Stop-BrowserdProcesses -PythonExe (Resolve-Path -LiteralPath $py).Path }
    Write-Ok 'Tarea borrada. browserd deja de arrancar al iniciar sesión.'
}

function Install {
    $repo = Resolve-Repo -Explicit $RepoDir
    $browserdDir = Join-Path $repo 'browserd'
    if (-not (Test-Path -LiteralPath (Join-Path $browserdDir 'requirements.txt') -PathType Leaf)) {
        throw "No encuentro browserd\requirements.txt bajo $repo. Corre el script dentro del repo de asistenta."
    }
    $py = Resolve-Python -Explicit $PythonExe -BrowserdDir $browserdDir
    $launcher = Join-Path $PSScriptRoot 'start-browserd-hidden.vbs'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "No encuentro el launcher $launcher. El repo está incompleto."
    }

    Write-Step "repo   : $repo"
    Write-Step "python : $py"

    # Comprobacion real: el paquete y sus dependencias importan con ESTE python
    # y DESDE browserdDir. El cwd importa dos veces: desde la raiz del repo,
    # `import browserd` resolveria el DIRECTORIO browserd\ como namespace package
    # vacio (falso positivo), y desde otro sitio cualquier paquete `browserd`
    # instalado fuera daria otro falso positivo. browserd.server y camoufox son
    # las dependencias reales del arranque: si el venv esta a medio instalar,
    # fallan aqui y no en cada logon (auditoria).
    Push-Location $browserdDir
    try {
        & $py -c "import browserd.server, camoufox" 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "El venv existe pero 'import browserd.server, camoufox' falla con ese python. Reinstala: deploy\browserd\setup-browserd.ps1"
        }
    } finally {
        Pop-Location
    }
    Write-Ok 'import browserd.server + camoufox OK (cwd browserd, python del venv)'

    $existing = Get-Task
    if ($existing -and -not $Force) {
        throw "Ya existe la tarea '$TaskName'. Usa -Force para reemplazarla o -Uninstall para quitarla."
    }
    $backupXml = $null
    if ($existing) {
        # Respaldo ANTES de tocar nada: si el registro nuevo falla, la tarea
        # vieja se restaura desde su XML y el PC no se queda sin autostart
        # (auditoria: borrar primero y registrar despues deja un hueco).
        $backupXml = Export-ScheduledTask -InputObject $existing
        Write-Step "Quito la tarea anterior ($($existing.State)); respaldo XML en memoria"
        Stop-ScheduledTask -InputObject $existing -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -InputObject $existing -Confirm:$false
        Stop-BrowserdProcesses -PythonExe $py
    }

    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $action = New-ScheduledTaskAction -Execute $wscript `
        -Argument "`"$launcher`" `"$py`" `"$browserdDir`"" `
        -WorkingDirectory $browserdDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    # Las dos que mas importan, dichas:
    #   RestartCount        -> si el proceso SALE (crash, OOM, alguien lo mata),
    #                          se reintenta un minuto despues, hasta 999 veces.
    #   ExecutionTimeLimit  -> [TimeSpan]::Zero es "sin limite". El defecto son
    #                          72 horas, que mataria un browserd sano cada tres
    #                          dias con su dueño dormido.
    # Un browserd vivo pero colgado es invisible para el Planificador: lo
    # detecta asistenta sondeando /health, no esta tarea.

    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

    Write-Step "Registro la tarea en '$TaskPath'"
    try {
        Register-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath $TaskPath `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal `
            -Description 'Sidecar browserd (Camoufox) en 127.0.0.1:7701. Arranca oculto via start-browserd-hidden.vbs. Reinicia solo si el proceso sale; un cuelgue lo ve asistenta por /health.' `
            -ErrorAction Stop | Out-Null
    }
    catch {
        $cause = $_.Exception.Message
        if ($backupXml) {
            try {
                Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml $backupXml -Force -ErrorAction Stop | Out-Null
                Write-Ok 'La tarea anterior quedó restaurada desde su respaldo XML.'
            } catch {
                Write-Bad "No se pudo registrar la tarea Y TAMPOCO restaurar la anterior: $($_.Exception.Message)"
            }
        }
        Write-Bad "No se pudo registrar la tarea: $cause"
        Write-Host '     Si es un problema de permisos, vuelve a ejecutar el script desde una consola de administrador.'
        throw
    }
    Write-Ok "Tarea '$TaskName' creada para $UserId"

    if ($Start) {
        if (Test-Browserd) {
            Write-Ok 'Ya hay un browserd válido respondiendo en 127.0.0.1:7701; la tarea queda registrada y no arranco otra instancia.'
        } else {
            Write-Step 'Arranco la tarea ahora'
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            $up = $false
            for ($i = 0; $i -lt 30 -and -not $up; $i++) {
                Start-Sleep -Seconds 1
                if (Test-Browserd) { $up = $true }
            }
            if (-not $up) {
                Write-Bad 'La tarea arrancó pero browserd no respondió con su contrato en 30s.'
                Write-Host "     Mira $browserdDir\logs\browserd.err.log y el resultado de la tarea con -Status."
                exit 1
            }
            Write-Ok 'browserd arriba y validado por /health.'
        }
    }

    Write-Host ''
    Show-Status | Out-Null
}

try {
    switch ($true) {
        ($Status) { if (Show-Status) { exit 0 } else { exit 1 } }
        ($Uninstall) { Uninstall; exit 0 }
        default { Install; exit 0 }
    }
}
catch {
    Write-Bad $_.Exception.Message
    exit 1
}
