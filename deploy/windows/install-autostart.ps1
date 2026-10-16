<#
.SYNOPSIS
    Registers (or removes) the personal-agent daemon as a Windows scheduled task.

.DESCRIPTION
    The daemon has to be running before anyone talks to it, which means it has to come
    back after a reboot. This script registers a Task Scheduler task that starts
    `node dist/cli.js serve` when the user logs on.

    Three decisions worth stating, because each one is a bug avoided:

    1. Task Scheduler, not the `Run` key in the registry. A `Run` entry is one line of
       text that fires once per logon and that nobody can see, retry, or configure; a
       task is an object with a trigger, settings, history and a last-result code, and it
       shows up in `taskschd.msc` where the user can find it. See deploy/windows/README.md.

    2. Registered under the *user's own* task folder with `-RunLevel Limited`, so no
       elevation is needed at all. The alternative — a SYSTEM task with "run whether the
       user is logged on or not" — runs in session 0, where there is no desktop: no
       screenshot, no mouse, no microphone. An agent that cannot see the screen is not
       the agent that was installed.

    3. The task runs the daemon only. It does *not* restart a hung daemon: Task Scheduler
       can restart a process that exited, but a process that is alive and stuck looks
       healthy to it. That case belongs to the watchdog (`src/watchdog.ts`), which reads
       the heartbeat file. This script does NOT install that watchdog process.

.PARAMETER Uninstall
    Stop and remove the task. Idempotent: removing a task that is not there is not an error.

.PARAMETER Status
    Report whether the task exists, when it last ran, and with what result. Read-only.

.PARAMETER TaskName
    Name of the scheduled task. Default `personal-agent-daemon`.

.PARAMETER RepoDir
    Repository root, i.e. the folder that contains `dist\cli.js`. Defaults to the parent
    of this script's folder.

.PARAMETER NodeExe
    Full path to `node.exe`. Defaults to whatever `node` resolves to in PATH.

.PARAMETER Command
    Subcommand to run. Default `serve`.

.PARAMETER Force
    Replace an existing task with the same name instead of refusing.

.PARAMETER Start
    Start the task right after registering it, instead of waiting for the next logon.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Status

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Uninstall
#>

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [switch] $Uninstall,
    [switch] $Status,
    [switch] $Start,
    [switch] $Force,
    [string] $TaskName = 'personal-agent-daemon',
    [string] $RepoDir,
    [string] $NodeExe,
    [string] $Command = 'serve'
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "==> $Message" }
function Write-Ok { param([string] $Message) Write-Host "  ok  $Message" -ForegroundColor Green }
function Write-Bad { param([string] $Message) Write-Host "  !!  $Message" -ForegroundColor Red }

# The installing user, always. A daemon that belongs to whoever ran this script is the
# only version that can read that user's vault, DPAPI secrets and desktop session.
$UserId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { "$env:COMPUTERNAME\$env:USERNAME" }

# Where the daemon keeps its state, mirroring `paths.ts`. Printed on install so the
# verification step does not depend on the reader remembering the layout.
$StateDir = if ($env:PA_STATE_DIR) { $env:PA_STATE_DIR } else { Join-Path $HOME '.local\share\personal-agent' }
$Heartbeat = Join-Path $StateDir 'agent.heartbeat'

# Tasks registered under the user's own folder need no administrator rights. Registering
# at the root of the tree does, and asking a user to elevate a script that does not need
# it teaches them to click through UAC without reading.
$TaskPath = "\$UserId\"

function Resolve-Node {
    param([string] $Explicit)
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) {
            throw "Node no existe en la ruta indicada: $Explicit"
        }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { throw 'No encuentro node.exe en el PATH. Instala Node o pasa -NodeExe "C:\ruta\node.exe".' }
    return $cmd.Source
}

function Resolve-Repo {
    param([string] $Explicit)
    if ($Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    # deploy\windows\install-autostart.ps1 -> deploy\windows -> deploy -> repo root
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

function Get-Task {
    # SilentlyContinue everywhere: "does it exist" is a question with an answer of
    # $null, not an exception, and -ErrorAction Stop on Get-ScheduledTask turns a missing
    # task into a crash.
    Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Show-Status {
    $task = Get-Task
    if (-not $task) {
        Write-Bad "No hay ninguna tarea llamada '$TaskName' en '$TaskPath'."
        Write-Host "     Instálala con: install-autostart.ps1"
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
    Write-Host "Límite       : $($task.Settings.ExecutionTimeLimit) · en batería: $($task.Settings.DisallowStartIfOnBatteries -eq $false)"
    if ($info.LastTaskResult -ne 0 -and $null -ne $info.LastRunTime) {
        Write-Bad 'La última ejecución terminó con error. Mira el log del daemon en el directorio de estado.'
    }
    Write-Host "Heartbeat    : $Heartbeat"
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
    Write-Ok "Tarea borrada. El daemon deja de arrancar al iniciar sesión."
}

function Install {
    $repo = Resolve-Repo -Explicit $RepoDir
    $node = Resolve-Node -Explicit $NodeExe
    $cli = Join-Path $repo 'dist\cli.js'

    Write-Step "node    : $node"
    Write-Step "repositorio: $repo"

    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        # Failing here rather than at logon: a task that fails silently at every boot is
        # far harder to notice than one that refuses to be created.
        throw "No encuentro $cli. Compila antes: npm run build"
    }
    Write-Ok "cli: $cli"

    $existing = Get-Task
    if ($existing -and -not $Force) {
        throw "Ya existe la tarea '$TaskName'. Usa -Force para reemplazarla o -Uninstall para quitarla."
    }
    if ($existing) {
        Write-Step "Quito la tarea anterior ($($existing.State))"
        Stop-ScheduledTask -InputObject $existing -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -InputObject $existing -Confirm:$false
    }

    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" $Command" -WorkingDirectory $repo
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    # The two settings above that matter most, spelled out:
    #   RestartCount      -> the daemon exiting (crash, OOM, someone killing it) is
    #                        retried a minute later, up to 999 times.
    #   ExecutionTimeLimit -> [TimeSpan]::Zero is "no limit". The default is 72 hours,
    #                        which would kill a perfectly healthy daemon every third day
    #                        while its owner was asleep.
    # A daemon hung but alive is invisible to Task Scheduler; that is the heartbeat
    # watchdog's job (src/watchdog.ts), not this task's.

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
            -Description 'personal-agent daemon (pa serve). Reinicia solo si el proceso sale; este instalador no cubre cuelgues.' `
            -ErrorAction Stop | Out-Null
    }
    catch {
        # The one case that genuinely needs elevation is a read-only or otherwise
        # locked-down Task Scheduler tree. Say so, instead of failing with a COM error.
        Write-Bad "No se pudo registrar la tarea: $($_.Exception.Message)"
        Write-Host '     Si es un problema de permisos, vuelve a ejecutar el script desde una consola de administrador.'
        throw
    }
    Write-Ok "Tarea '$TaskName' creada para $UserId"

    if ($Start) {
        Write-Step 'Arranco la tarea ahora'
        Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
        Write-Ok 'Arrancada. El daemon escribe su heartbeat en unos segundos:'
        Write-Host "     Get-Item $Heartbeat | Select-Object LastWriteTime"
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
