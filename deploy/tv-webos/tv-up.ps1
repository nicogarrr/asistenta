$TvIp = if ($env:TV_IP) { $env:TV_IP } else { '192.168.1.237' }
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect($TvIp, 23)
$stream = $client.GetStream()

function Read-All {
    param($stream, [int]$waitMs = 4000)
    Start-Sleep -Milliseconds $waitMs
    $buf = New-Object byte[] 16384
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

function Send-Cmd {
    param($stream, [string]$cmd, [int]$waitMs = 4000)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
    return Read-All -stream $stream -waitMs $waitMs
}

Read-All -stream $stream -waitMs 1500 | Out-Null

Write-Host "=== tailscale up ==="
$upCmd = "/media/developer/bin/tailscale --socket=/media/developer/var/tailscale/tailscaled.sock up --accept-dns=false --accept-routes=false --netfilter-mode=off 2>&1"
$r = Send-Cmd -stream $stream -cmd $upCmd -waitMs 10000
Write-Host $r

# Status check
Write-Host "=== tailscale status ==="
$r = Send-Cmd -stream $stream -cmd "/media/developer/bin/tailscale --socket=/media/developer/var/tailscale/tailscaled.sock status 2>&1" -waitMs 5000
Write-Host $r

Write-Host "=== tailscale netcheck ==="
$r = Send-Cmd -stream $stream -cmd "/media/developer/bin/tailscale --socket=/media/developer/var/tailscale/tailscaled.sock netcheck 2>&1" -waitMs 8000
Write-Host $r

# Check log for the auth URL line
Write-Host "=== log tail (look for auth URL) ==="
$r = Send-Cmd -stream $stream -cmd "tail -30 /media/developer/var/tailscaled.log 2>&1" -waitMs 3000
Write-Host $r

$stream.Close()
$client.Close()