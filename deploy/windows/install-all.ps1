#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess=$true)]
param(
 [ValidateSet('install','status','uninstall')][string]$Action='install',
 [string]$RepoDir, [string]$NodeExe, [string]$StateDir,
 [switch]$DisableLocalLlm, [switch]$Start, [switch]$LibraryOnly
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'autostart-core.ps1')
function Get-AllStatus {
 param([string]$State)
 $identity=Get-TaskIdentity
 $tasks=@('personal-agent-daemon','browserd-sidecar') | ForEach-Object {
  $t=Get-ScheduledTask -TaskName $_ -TaskPath $identity.Path -ErrorAction SilentlyContinue
  $info=if($t){Get-ScheduledTaskInfo -TaskName $_ -TaskPath $identity.Path -ErrorAction SilentlyContinue}else{$null}
  @{Name=$_;Installed=($null -ne $t);State=$(if($t){[string]$t.State}else{'missing'});LastResult=$(if($info){$info.LastTaskResult}else{$null})}
 }
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$beat=Read-HeartbeatTimestamp $State
 @{Tasks=@($tasks);HeartbeatAgeSeconds=$(if($null -ne $beat -and $beat -le $now){[math]::Floor(($now-$beat)/1000)}else{$null});Browserd=(Test-LocalService 'browserd');LocalLlm=(Test-LocalService 'opencode');TvListener=(Test-LocalService 'tv')}
}
function Ensure-AllTaskFolder {
 param([string]$Path)
 $service=New-Object -ComObject 'Schedule.Service';$service.Connect();$folder=$service.GetFolder('\')
 foreach($part in $Path.Trim('\').Split('\')){try{$folder=$folder.GetFolder($part)}catch{$folder=$folder.CreateFolder($part,$null)}}
}
function Set-AllTasks {
 param([string]$Repo,[string]$Node,[string]$State,[bool]$Llm)
 $identity=Get-TaskIdentity
 # No secrets in args. The chosen opt-in is in the literal task action, not ambient env.
 $stack=Join-Path $Repo 'deploy\windows\run-stack.ps1'
 $invoke='& '+(ConvertTo-Literal $stack)+' -RepoDir '+(ConvertTo-Literal $Repo)+' -NodeExe '+(ConvertTo-Literal $Node)+' -StateDir '+(ConvertTo-Literal $State)+' -EnableLocalLlm:$'+$Llm.ToString().ToLower()+'; exit $LASTEXITCODE'
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($invoke))
 $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $daemon=New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $encoded" -WorkingDirectory $Repo
 $py=Join-Path $Repo 'browserd\.venv\Scripts\python.exe'
 $vbs=Join-Path $Repo 'deploy\browserd\start-browserd-hidden.vbs';$bd=Join-Path $Repo 'browserd'
 $browser=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('"'+$vbs+'" "'+$py+'" "'+$bd+'"') -WorkingDirectory $Repo
 $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.User
 # Watchdog budget is the only restart loop for hangs. Process exits also capped by Task Scheduler.
 $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
 $principal=New-ScheduledTaskPrincipal -UserId $identity.User -LogonType Interactive -RunLevel Limited
 Ensure-AllTaskFolder $identity.Path
 $plans=@(@{Name='browserd-sidecar';Action=$browser},@{Name='personal-agent-daemon';Action=$daemon})
 $previous=@{};$changed=@()
 try {
  foreach($plan in $plans){
   $old=Get-ScheduledTask -TaskName $plan.Name -TaskPath $identity.Path -ErrorAction SilentlyContinue
   $previous[$plan.Name]=$(if($old){Export-ScheduledTask -TaskName $plan.Name -TaskPath $identity.Path}else{$null})
   Register-ScheduledTask -TaskName $plan.Name -TaskPath $identity.Path -Action $plan.Action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
   $changed+=@($plan.Name)
  }
 }catch{
  foreach($name in $changed){if($previous[$name]){Register-ScheduledTask -TaskName $name -TaskPath $identity.Path -Xml $previous[$name] -Force | Out-Null}else{Unregister-ScheduledTask -TaskName $name -TaskPath $identity.Path -Confirm:$false}}
  throw
 }
}
if($LibraryOnly){return}
try{
 $repo=if($RepoDir){(Resolve-Path -LiteralPath $RepoDir).Path}else{(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path}
 $node=if($NodeExe){(Resolve-Path -LiteralPath $NodeExe).Path}else{(Get-Command node.exe -ErrorAction Stop | Select-Object -First 1).Source}
 if(-not $StateDir){
  Push-Location -LiteralPath $repo
  try{$StateDir=[string](& $node (Join-Path $PSScriptRoot 'resolve-state.mjs'));if($LASTEXITCODE -ne 0){throw 'No se pudo resolver el estado.'}}finally{Pop-Location}
 }
 if(-not [IO.Path]::IsPathRooted($StateDir)){throw 'StateDir debe ser absoluto.'}
 $identity=Get-TaskIdentity
 if($Action -eq 'status'){Get-AllStatus $StateDir | ConvertTo-Json -Depth 5;exit 0}
 if($Action -eq 'uninstall'){
  if($PSCmdlet.ShouldProcess('Tareas propias de Asistenta','Quitar autoarranque; mantener dependencias, datos y Docker')){
   $task=Get-ScheduledTask -TaskName 'personal-agent-daemon' -TaskPath $identity.Path -ErrorAction SilentlyContinue
   if($task -and $task.State -eq 'Running'){
    $env:PA_STATE_DIR=$StateDir
    $result=Invoke-BoundedProgram $node ('"'+(Join-Path $repo 'dist\cli.js')+'" stop') 40 $repo
    if($result.Code -ne 0){throw 'Parada limpia no confirmada; no se quitan las tareas.'}
   }
   foreach($name in @('personal-agent-daemon','browserd-sidecar')){if(Get-ScheduledTask -TaskName $name -TaskPath $identity.Path -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName $name -TaskPath $identity.Path -Confirm:$false}}
  };exit 0
 }
 foreach($file in @('dist\cli.js','deploy\windows\run-stack.ps1','deploy\windows\run-hidden.ps1','deploy\browserd\start-browserd-hidden.vbs','browserd\.venv\Scripts\python.exe')){if(-not(Test-Path -LiteralPath (Join-Path $repo $file) -PathType Leaf)){throw "Falta requisito: $file"}}
 $v=[string](& $node --version);if($LASTEXITCODE -ne 0 -or $v -notmatch '^v([0-9]+)\.' -or [int]$Matches[1] -lt 24){throw 'Se requiere Node24 o posterior.'}
 if($PSCmdlet.ShouldProcess('Tareas propias de Asistenta','Instalar/actualizar arranque completo; Docker opt-in')){
  Set-AllTasks $repo $node $StateDir (-not [bool]$DisableLocalLlm)
  if($Start){foreach($name in @('browserd-sidecar','personal-agent-daemon')){$t=Get-ScheduledTask -TaskName $name -TaskPath $identity.Path;if($t.State -ne 'Running'){Start-ScheduledTask -TaskName $name -TaskPath $identity.Path}}}
 }
 Write-Output 'Instalación solicitada. No se reinicia una instancia ya activa. Consulta pa autostart status.'
 exit 0
}catch{
 # Motivo corto y estable para pa autostart (sin rutas, configuracion ni secretos).
 $m=[string]$_.Exception.Message;$h=$_.Exception.HResult
 $motivo=if($m -like 'Falta requisito: dist\*'){'compilar'}elseif($m -like 'Falta requisito: browserd\*'){'navegador'}elseif($m -like 'Falta requisito:*'){'archivos'}elseif($m -like 'Se requiere Node24*'){'node'}elseif($m -like 'Parada limpia no confirmada*'){'parada'}elseif($_.Exception -is [UnauthorizedAccessException] -or $h -eq -2147024891){'permiso'}else{'otro'}
 [Console]::Error.WriteLine('MOTIVO='+$motivo)
 [Console]::Error.WriteLine('No se completó autoarranque; revisa requisitos/permisos locales. No se imprimen configuración ni secretos.');exit 1}
