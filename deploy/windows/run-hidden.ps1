<# Runs in the installing user's desktop session. No prompts or secrets in arguments.
   This process waits for node, so Task Scheduler sees its real exit code. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $RepoDir,
    [Parameter(Mandatory = $true)][string] $NodeExe,
    [Parameter(Mandatory = $true)][string] $StateDir
)
$ErrorActionPreference = 'Stop'
$process = $null
$started = $false
$outFile = $null
$errFile = $null
$exitCode = 1
$logsValidated = $false
try {
    # Resolve before launching: never inherit a shell alias or terminal wrapper.
    $repo = (Resolve-Path -LiteralPath $RepoDir).Path
    $node = (Resolve-Path -LiteralPath $NodeExe).Path
    $cli = Join-Path $repo 'dist\cli.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Falta dist\cli.js; ejecuta npm run build.' }
    if (-not [IO.Path]::IsPathRooted($StateDir)) { throw 'StateDir debe ser una ruta absoluta.' }
    $env:PA_STATE_DIR = $StateDir
    . (Join-Path $PSScriptRoot 'private-logs.ps1')
    Assert-PrivateLogTargets $StateDir
    $logDir = Join-Path $StateDir 'log'
    # A private state directory under the current user's profile is required.
    # Do not change ACLs or take ownership of an existing directory silently.
    $logsValidated = $true
    $outPath = Join-Path $logDir 'launcher.stdout.log'
    $errPath = Join-Path $logDir 'launcher.stderr.log'
    foreach ($file in @($outPath, $errPath)) {
        if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 10MB) {
            Move-Item -LiteralPath $file -Destination "$file.previous" -Force
        }
    }
    Add-Content -LiteralPath $errPath -Value "$(Get-Date -Format o) inicio de serve (sin TTY)" -Encoding UTF8
    $outFile = [IO.File]::Open($outPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $errFile = [IO.File]::Open($errPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $node
    $info.Arguments = '"' + $cli + '" serve'
    $info.WorkingDirectory = $repo
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'No se pudo iniciar node.exe.' }
    $started = $true
    # Equivalent to stdin=NUL: no interactive terminal is needed by serve/DPAPI.
    $process.StandardInput.Close()
    $outCopy = $process.StandardOutput.BaseStream.CopyToAsync($outFile)
    $errCopy = $process.StandardError.BaseStream.CopyToAsync($errFile)
    $process.WaitForExit()
    $outCopy.GetAwaiter().GetResult()
    $errCopy.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
}
catch {
    # Keep diagnostics in the user's local log. Never print configuration/secrets.
    if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    if ($errFile) { $errFile.Dispose(); $errFile = $null }
    $message = "$(Get-Date -Format o) error del launcher: $($_.Exception.Message)"
    if ($logsValidated) { Add-Content -LiteralPath $errPath -Value $message -Encoding UTF8 }
    else { [Console]::Error.WriteLine($message) }
}
finally {
    if ($process) { $process.Dispose() }
    if ($outFile) { $outFile.Dispose() }
    if ($errFile) { $errFile.Dispose() }
}
if ($logsValidated) { Add-Content -LiteralPath $errPath -Value "$(Get-Date -Format o) serve termino: exit=$exitCode" -Encoding UTF8 }
exit $exitCode
