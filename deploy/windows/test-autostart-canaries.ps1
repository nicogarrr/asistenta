# No real task writes, network, Docker, process termination or user configuration.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'install-all.ps1') -LibraryOnly
function Assert($value,$message){if(-not $value){throw $message}}
$now=2000000;$began=1000000
Assert ((Get-SupervisionDecision $now $began ($now-120000) @()).Action -eq 'none') 'exact stale boundary'
Assert ((Get-SupervisionDecision $now $began ($now-120001) @()).Action -eq 'restart') 'stale must restart'
Assert ((Get-SupervisionDecision $now ($now-1000) ($now-999999) @()).Action -eq 'wait') 'startup grace'
Assert ((Get-SupervisionDecision $now $began $null @()).Action -eq 'report') 'missing heartbeat no kill'
Assert ((Get-SupervisionDecision $now $began ($now+1) @()).Action -eq 'report') 'future heartbeat no kill'
Assert ((Get-SupervisionDecision $now $began ($began-1) @()).Action -eq 'report') 'old instance no kill'
Assert ((Get-SupervisionDecision $now $began ($now-120001) @(($now-1),($now-2),($now-3))).Action -eq 'blocked') 'persistent budget'
Assert ((Get-SupervisionDecision $now $began ($now-120001) @($now-900001)).Action -eq 'restart') 'window expires'
$script:kills=0;$script:stops=0;$script:notices=@()
$child=New-Object PSObject -Property @{HasExited=$false;Id=123}
$child | Add-Member ScriptMethod WaitForExit {param($ms) return $false}
$child | Add-Member ScriptMethod Kill {$script:kills++}
$result=Invoke-OwnedChildRecovery $child {$script:stops++} {param($event)$script:notices+=@($event)}
Assert ($result -eq 'forced' -and $script:kills -eq 1 -and $script:stops -eq 1) 'owned child only after clean stop'
Assert (($script:notices -join ',') -eq 'restart,forced') 'accurate forced notice'
$child.HasExited=$true
$script:kills=0
$child | Add-Member ScriptMethod WaitForExit {param($ms) return $true} -Force
Assert ((Invoke-OwnedChildRecovery $child {} {}) -eq 'clean' -and $script:kills -eq 0) 'clean stop never force kills'

function Get-TaskIdentity {return @{User='SYNTHETIC\user';Path='\SYNTHETIC\user\'}}
function Ensure-AllTaskFolder {param($Path)}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) return @{Execute=$Execute;Argument=$Argument;WorkingDirectory=$WorkingDirectory}}
function New-ScheduledTaskTrigger {param([switch]$AtLogOn,$User)return @{User=$User}}
function New-ScheduledTaskSettingsSet {param([switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,[switch]$StartWhenAvailable,$RestartCount,$RestartInterval,$ExecutionTimeLimit,$MultipleInstances)return @{MultipleInstances=$MultipleInstances;RestartCount=$RestartCount}}
function New-ScheduledTaskPrincipal {param($UserId,$LogonType,$RunLevel)return @{RunLevel=$RunLevel}}
$script:tasks=@{};$script:registered=0
function Get-ScheduledTask {param($TaskName,$TaskPath,$ErrorAction)return $script:tasks[$TaskName]}
function Export-ScheduledTask {param($TaskName,$TaskPath)return 'synthetic xml'}
function Register-ScheduledTask {param($TaskName,$TaskPath,$Action,$Trigger,$Settings,$Principal,[switch]$Force,$ErrorAction,$Xml)$script:tasks[$TaskName]=@{Action=$Action;Settings=$Settings;Principal=$Principal};$script:registered++}
if(-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6){New-PSDrive -Name C -PSProvider FileSystem -Root /tmp | Out-Null}
$env:SystemRoot='C:\Windows'
$repo="C:\repo with space & apostrophe's";$node='C:\Program Files\nodejs\node.exe';$state="C:\private state's"
Set-AllTasks $repo $node $state $true
Set-AllTasks $repo $node $state $true
Assert ($script:tasks.Count -eq 2 -and $script:registered -eq 4) 'idempotent replacement, no duplicate tasks'
$d=$script:tasks['personal-agent-daemon']
Assert ($d.Settings.MultipleInstances -eq 'IgnoreNew' -and $d.Settings.RestartCount -eq 3 -and $d.Principal.RunLevel -eq 'Limited') 'limited single instance bounded restart'
$encoded=($d.Action.Argument -split ' ')[-1]
$decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
Assert ($decoded.Contains("apostrophe''s") -and $decoded.Contains('-EnableLocalLlm:$true')) 'literal apostrophe path and local LLM enabled'
Set-AllTasks $repo $node $state $false
$decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(($script:tasks['personal-agent-daemon'].Action.Argument -split ' ')[-1]))
Assert ($decoded.Contains('-EnableLocalLlm:$false')) 'explicit disable config'
# Bounded startup degradation uses mocks only. No Docker/network processes.
function Get-Command {param($Name,$ErrorAction) return @{Source='synthetic-docker'}}
function Test-LocalService {param($Service)return $false}
$script:programs=@();$script:mode='missing'
function Invoke-BoundedProgram {
 param($Exe,$Arguments,$Seconds,$Directory)
 $script:programs+=@($Arguments)
 if($Arguments -like 'info*'){return @{Code=0;Output='synthetic'}}
 if($Arguments -like 'inspect*'){return @{Code=1;Output=''}}
 throw 'Unexpected mutation'
}
Assert ((Start-OptionalOpenCode $false) -eq 'disabled' -and $script:programs.Count -eq 0) 'explicit opt-out no docker'
Assert ((Start-OptionalOpenCode $true) -eq 'container-missing') 'missing optional LLM degrades'
Assert (($script:programs -join '|') -notmatch '(^|\|)(start|run|rm|pull) ') 'missing container never created'
$script:programs=@()
function Invoke-BoundedProgram {
 param($Exe,$Arguments,$Seconds,$Directory)
 $script:programs+=@($Arguments)
 if($Arguments -like 'info*'){return @{Code=0;Output='synthetic'}}
 return @{Code=0;Output='[{"HostConfig":{"Privileged":true,"PortBindings":{}},"Config":{},"Mounts":[]}]'}
}
Assert ((Start-OptionalOpenCode $true) -eq 'container-unsafe') 'unsafe container not started'
Assert (($script:programs -join '|') -notmatch '^start|\|start') 'unsafe never started'

Write-Output 'autostart canaries OK (mocked Scheduler and owned child; no live changes)'
