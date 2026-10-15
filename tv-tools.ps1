$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.1.237', 23)
$stream = $client.GetStream()

function Read-All {
    param($stream, [int]$waitMs = 1200)
    Start-Sleep -Milliseconds $waitMs
    $buf = New-Object byte[] 8192
    $sb = New-Object System.Text.StringBuilder
    $stream.ReadTimeout = 800
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
    param($stream, [string]$cmd, [int]$waitMs = 1200)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
    return Read-All -stream $stream -waitMs $waitMs
}

Read-All -stream $stream -waitMs 1500 | Out-Null

Write-Host "=== Tools check ==="
Send-Cmd -stream $stream -cmd "for t in wget curl sshd scp base64 sha256sum openssl; do printf '%-12s ' $t; which $t 2>/dev/null || echo MISSING; done; echo DONE" | Write-Host

Write-Host "=== /media listing ==="
Send-Cmd -stream $stream -cmd "ls -la /media 2>&1; echo DONE" | Write-Host

Write-Host "=== writable check ==="
Send-Cmd -stream $stream -cmd "mkdir -p /media/developer/bin 2>&1; ls -la /media/ 2>&1; echo DONE" | Write-Host

Write-Host "=== net interfaces ==="
Send-Cmd -stream $stream -cmd "ip a 2>&1 | head -30; echo DONE" | Write-Host

Write-Host "=== gateway / DNS ==="
Send-Cmd -stream $stream -cmd "ip route 2>&1; echo --; cat /etc/resolv.conf 2>&1; echo DONE" | Write-Host

Write-Host "=== free space / mounts ==="
Send-Cmd -stream $stream -cmd "df -h 2>&1 | head -20; echo DONE" | Write-Host

$stream.Close()
$client.Close()