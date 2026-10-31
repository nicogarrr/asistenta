# Library only. No task registration, Docker, network or process writes at import.
function ConvertTo-Literal { param([string]$Value) return "'" + $Value.Replace("'", "''") + "'" }
function Get-TaskIdentity {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    return @{User=$user;Path="\$user\"}
}
function Test-LocalService {
    param([ValidateSet('browserd','opencode','tv')][string]$Service)
    $url = switch($Service){'browserd'{'http://127.0.0.1:7701/health'}'opencode'{'http://127.0.0.1:4096/global/health'}'tv'{'http://127.0.0.1:8765/tv/button-health'}}
    try {
        $r=Invoke-RestMethod -Uri $url -TimeoutSec 2
        switch($Service){
            'browserd'{return ($r.service -eq 'browserd' -and $r.version -and $r.capabilities -contains 'read')}
            'opencode'{return ($r.healthy -eq $true -and [bool]$r.version)}
            'tv'{return ($r.ok -eq $true)}
        }
    } catch { return $false }
}
function Wait-LocalService {
    param([string]$Service,[int]$Seconds)
    $until=[DateTime]::UtcNow.AddSeconds($Seconds)
    do {if(Test-LocalService $Service){return $true};Start-Sleep -Milliseconds 500}while([DateTime]::UtcNow -lt $until)
    return $false
}
function Get-SupervisionDecision {
    param([double]$Now,[double]$Started,[Nullable[double]]$Heartbeat,[double[]]$Restarts=@())
    $recent=@($Restarts | Where-Object {$_ -le $Now -and $_ -ge ($Now-900000)})
    if($Now -lt $Started -or ($Now-$Started) -lt 180000){return @{Action='wait';Recent=$recent}}
    if($null -eq $Heartbeat -or $Heartbeat -gt $Now -or $Heartbeat -lt $Started){return @{Action='report';Recent=$recent}}
    if(($Now-$Heartbeat) -le 120000){return @{Action='none';Recent=$recent}}
    if($recent.Count -ge 3){return @{Action='blocked';Recent=$recent}}
    return @{Action='restart';Recent=$recent}
}
function Read-HeartbeatTimestamp {
    param([string]$StateDir)
    try {$raw=[IO.File]::ReadAllText((Join-Path $StateDir 'agent.heartbeat')).Trim();$n=0L;if($raw -match '^[1-9][0-9]{0,15}$' -and [long]::TryParse($raw,[ref]$n)){return [double]$n}}catch{}
    return $null
}
function Invoke-BoundedProgram {
    param([string]$Exe,[string]$Arguments,[int]$Seconds=10,[string]$Directory)
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$Exe;$info.Arguments=$Arguments;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    if($Directory){$info.WorkingDirectory=$Directory}
    $p=New-Object Diagnostics.Process;$p.StartInfo=$info
    try {
        if(-not $p.Start()){throw 'No se pudo iniciar el auxiliar.'}
        $out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
        if(-not $p.WaitForExit($Seconds*1000)){$p.Kill();$p.WaitForExit();throw 'Auxiliar agotó el plazo.'}
        return @{Code=$p.ExitCode;Output=$out.GetAwaiter().GetResult()}
    }finally{$p.Dispose()}
}
function Start-OptionalOpenCode {
    param([bool]$Enabled)
    if(-not $Enabled){return 'disabled'}
    $docker=Get-Command docker.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if(-not $docker){return 'docker-missing'}
    try {
        $info=Invoke-BoundedProgram $docker.Source 'info --format "{{.ServerVersion}}"' 5
        if($info.Code -ne 0){
            $desktop=Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
            if(-not(Test-Path -LiteralPath $desktop -PathType Leaf)){return 'docker-unavailable'}
            Start-Process -FilePath $desktop | Out-Null
            $until=[DateTime]::UtcNow.AddSeconds(45)
            do {Start-Sleep -Seconds 2;$info=Invoke-BoundedProgram $docker.Source 'info --format "{{.ServerVersion}}"' 5}while($info.Code -ne 0 -and [DateTime]::UtcNow -lt $until)
            if($info.Code -ne 0){return 'docker-timeout'}
        }
        # Existing named container only. Never create, pull, remove, mount, or print inspect contents.
        $inspection=Invoke-BoundedProgram $docker.Source 'inspect asistenta-opencode' 5
        if($inspection.Code -ne 0){return 'container-missing'}
        $c=@($inspection.Output | ConvertFrom-Json)[0]
        $ports=@($c.HostConfig.PortBindings.'4096/tcp');$mounts=@($c.Mounts)
        if($c.HostConfig.Privileged -or $c.HostConfig.NetworkMode -eq 'host' -or $ports.Count -ne 1 -or $ports[0].HostIp -ne '127.0.0.1' -or $ports[0].HostPort -ne '4096' -or @($c.HostConfig.PortBindings.PSObject.Properties).Count -ne 1){return 'container-unsafe'}
        $auth=Join-Path $env:USERPROFILE '.local\share\opencode\auth.json';$work=Join-Path $env:USERPROFILE 'opencode-serve'
        $authMount=@($mounts | Where-Object {$_.Destination -eq '/root/.local/share/opencode/auth.json' -and $_.Source -eq $auth -and -not $_.RW})
        $workMount=@($mounts | Where-Object {$_.Destination -eq '/work' -and $_.Source -eq $work -and $_.RW})
        if($mounts.Count -ne 2 -or $authMount.Count -ne 1 -or $workMount.Count -ne 1 -or $c.Config.WorkingDir -ne '/work' -or $c.Config.Image -ne 'node@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8'){return 'container-unsafe'}
        $expectedCommand=@('bash','-c','npm i -g opencode-ai@1.19.0 --silent && opencode serve --hostname 0.0.0.0 --port 4096')
        if(($c.Config.Cmd -join "`n") -cne ($expectedCommand -join "`n") -or ($c.Config.Entrypoint -join '') -cne 'docker-entrypoint.sh' -or @($c.HostConfig.CapAdd | Where-Object {$_}).Count -gt 0 -or @($c.HostConfig.Devices | Where-Object {$_}).Count -gt 0 -or $c.HostConfig.PidMode -eq 'host'){return 'container-unsafe'}
        if(Test-LocalService 'opencode'){return 'ready'}
        $start=Invoke-BoundedProgram $docker.Source 'start asistenta-opencode' 10
        if($start.Code -ne 0){return 'container-start-failed'}
        if(Wait-LocalService 'opencode' 30){return 'ready'}
        return 'llm-timeout'
    }catch{return 'llm-unavailable'}
}
function Read-RestartBudget {
 param([string]$Path)
 Assert-NoReparsePath $Path
 if(-not(Test-Path -LiteralPath $Path)){return @()}
 Assert-PrivateAcl $Path
 $data=[IO.File]::ReadAllText($Path) | ConvertFrom-Json
 if($null -eq $data -or $null -eq $data.Restarts){throw 'Presupuesto ilegible: no se reinicia.'}
 foreach($n in @($data.Restarts)){if($n -isnot [long] -and $n -isnot [int] -and $n -isnot [double]){throw 'Presupuesto inválido.'};if($n -le 0 -or [double]::IsNaN($n) -or [double]::IsInfinity($n)){throw 'Presupuesto inválido.'}}
 return @($data.Restarts)
}
function Save-RestartBudget {
 param([string]$Path,[double[]]$Restarts)
 Assert-NoReparsePath $Path
 if(Test-Path -LiteralPath $Path){Assert-PrivateAcl $Path}
 # Parent is the verified private log directory. CreateNew refuses preplaced temporary links.
 $tmp=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 $f=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{Restarts=@($Restarts)} | ConvertTo-Json -Compress));$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
 try{Move-Item -LiteralPath $tmp -Destination $Path -Force}finally{if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force}}
}
function Invoke-OwnedChildRecovery {
 param($Child,[scriptblock]$CleanStop,[scriptblock]$Notify)
 # The caller passes its actual Process object, never a number read from agent.pid.
 & $Notify 'restart'
 try{& $CleanStop | Out-Null}catch{}
 if($Child.WaitForExit(5000)){return 'clean'}
 if(-not $Child.HasExited){$Child.Kill();[void]$Child.WaitForExit(5000);& $Notify 'forced';return 'forced'}
 return 'clean'
}
function Invoke-BudgetedRecovery {
 param($Child,[scriptblock]$CleanStop,[scriptblock]$Notify,[string]$BudgetPath,[double[]]$Restarts)
 Save-RestartBudget $BudgetPath $Restarts
 return Invoke-OwnedChildRecovery $Child $CleanStop $Notify
}
