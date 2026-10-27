# PowerShell telnet client with byte-level read
$TvIp = if ($env:TV_IP) { $env:TV_IP } else { '192.168.1.237' }
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect($TvIp, 23)
$client.ReceiveTimeout = 5000
$stream = $client.GetStream()

function Read-All {
    param($stream, [int]$waitMs = 1500)
    Start-Sleep -Milliseconds $waitMs
    $buf = New-Object byte[] 8192
    $sb = New-Object System.Text.StringBuilder
    $stream.ReadTimeout = 1000
    while ($true) {
        try {
            $n = $stream.Read($buf, 0, $buf.Length)
            if ($n -le 0) { break }
            [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $n))
        } catch {
            break
        }
    }
    return $sb.ToString()
}

Write-Host "=== Initial banner ==="
$initial = Read-All -stream $stream -waitMs 2000
Write-Host $initial

# Send newline to confirm shell
$stream.Write([byte[]]@(13, 10), 0, 2)
$resp = Read-All -stream $stream -waitMs 1500
Write-Host "=== After newline ==="
Write-Host $resp

# Send uname -a
$stream.Write([System.Text.Encoding]::UTF8.GetBytes("uname -a`r`n"), 0, 17)
$resp = Read-All -stream $stream -waitMs 1200
Write-Host "=== uname -a ==="
Write-Host $resp

# Send uname -m
$stream.Write([System.Text.Encoding]::UTF8.GetBytes("uname -m`r`n"), 0, 10)
$resp = Read-All -stream $stream -waitMs 800
Write-Host "=== uname -m ==="
Write-Host $resp

# Check /dev/net/tun
$cmd = "ls -la /dev/net/tun 2>&1; echo DONE`r`n"
$stream.Write([System.Text.Encoding]::UTF8.GetBytes($cmd), 0, $cmd.Length)
$resp = Read-All -stream $stream -waitMs 1200
Write-Host "=== /dev/net/tun ==="
Write-Host $resp

# webOS
$cmd = "cat /etc/starfish-release 2>&1 | head -5; echo DONE`r`n"
$stream.Write([System.Text.Encoding]::UTF8.GetBytes($cmd), 0, $cmd.Length)
$resp = Read-All -stream $stream -waitMs 1200
Write-Host "=== webOS ==="
Write-Host $resp

# whoami / id
$cmd = "whoami; pwd; id; echo DONE`r`n"
$stream.Write([System.Text.Encoding]::UTF8.GetBytes($cmd), 0, $cmd.Length)
$resp = Read-All -stream $stream -waitMs 1200
Write-Host "=== whoami ==="
Write-Host $resp

# exit
$stream.Close()
$client.Close()