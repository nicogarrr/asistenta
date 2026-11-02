# Task Scheduler owns this process; dependencies warm up before serve. Optional failures degrade, not abort.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RepoDir,[Parameter(Mandatory=$true)][string]$NodeExe,[Parameter(Mandatory=$true)][string]$StateDir,[bool]$EnableLocalLlm=$true)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'autostart-core.ps1')
$identity=Get-TaskIdentity
try {
 if(-not(Test-LocalService 'browserd')){
  $task=Get-ScheduledTask -TaskName 'browserd-sidecar' -TaskPath $identity.Path -ErrorAction SilentlyContinue
  if($task -and $task.State -ne 'Running'){Start-ScheduledTask -TaskName 'browserd-sidecar' -TaskPath $identity.Path}
  [void](Wait-LocalService 'browserd' 20)
 }
}catch{}
# Docker/OpenCode local solo con PA_PROVIDER_PRESET=opencode-local; con la nube, ni se abre Docker.
$llm=Start-OptionalOpenCode $EnableLocalLlm (Get-ProviderPreset $RepoDir)
# A failed/missing optional dependency does not prevent Telegram, heartbeat or other daemon services.
$env:PA_AUTOSTART_LLM_STATUS=$llm
$env:PA_AUTOSTART_SUPERVISE='1'
& (Join-Path $PSScriptRoot 'run-hidden.ps1') -RepoDir $RepoDir -NodeExe $NodeExe -StateDir $StateDir
exit $LASTEXITCODE
