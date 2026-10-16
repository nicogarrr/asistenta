$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.1.237', 23)
$stream = $client.GetStream()

function Read-All {
    param($stream, [int]$waitMs = 2500)
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
    param($stream, [string]$cmd, [int]$waitMs = 2500)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
    return Read-All -stream $stream -waitMs $waitMs
}

Read-All -stream $stream -waitMs 1500 | Out-Null

# Prepare state dir
Write-Host "=== prepare state dir ==="
$r = Send-Cmd -stream $stream -cmd "mkdir -p /media/developer/var/tailscale && ls -la /media/developer/var/tailscale; echo DONE" -waitMs 3000
Write-Host $r

# Start tailscaled in background
Write-Host "=== starting tailscaled ==="
$startCmd = "nohup /media/developer/bin/tailscaled --statedir=/media/developer/var/tailscale --socket=/media/developer/var/tailscale/tailscaled.sock >/media/developer/var/tailscaled.log 2>&1 &"
$r = Send-Cmd -stream $stream -cmd $startCmd -waitMs 2000
Write-Host $r

# Wait for it to start
Write-Host "=== waiting for tailscaled ==="
$r = Send-Cmd -stream $stream -cmd "sleep 5; ps -ef | grep tailscaled | grep -v grep; echo --; ls -la /media/developer/var/tailscale/; echo --; cat /media/developer/var/tailscaled.log 2>&1 | tail -30; echo DONE" -waitMs 12000
Write-Host $r

$stream.Close()
$client.Close()