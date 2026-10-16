# Shared only by the launcher and native tests. Never repair an existing ACL silently.
function Assert-NoReparsePath {
    param([string] $Path)
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Ruta de logs rechazada: enlace/reparse point.' }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Assert-PrivateAcl {
    param([string] $Path)
    Assert-NoReparsePath $Path
    $acl = Get-Acl -LiteralPath $Path
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Ruta de logs rechazada: propietario distinto del usuario actual.' }
    $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Value -notin $trusted -and
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {
            throw 'Ruta de logs rechazada: ACL compartida con otros usuarios.'
        }
    }
}
function New-PrivateDirectory {
    param([string] $Path)
    Assert-NoReparsePath $Path
    if (Test-Path -LiteralPath $Path) {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'La ruta de logs no es un directorio.' }
        Assert-PrivateAcl $Path
        return
    }
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { New-PrivateDirectory $parent }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    $directory = New-Object IO.DirectoryInfo($Path)
    $directory.Create($acl)
    Assert-PrivateAcl $Path
}
function Assert-PrivateLogTargets {
    param([string] $StateDir)
    New-PrivateDirectory $StateDir
    $log = Join-Path $StateDir 'log'
    New-PrivateDirectory $log
    foreach ($name in @('launcher.stdout.log', 'launcher.stderr.log', 'launcher.stdout.log.previous', 'launcher.stderr.log.previous')) {
        $path = Join-Path $log $name
        Assert-NoReparsePath $path
        if (Test-Path -LiteralPath $path) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'El destino del log no es un archivo.' }
            Assert-PrivateAcl $path
        }
    }
}
