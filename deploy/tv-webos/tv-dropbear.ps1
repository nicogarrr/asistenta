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

# drain initial
Read-All -stream $stream -waitMs 1500 | Out-Null

# Check dropbear
Write-Host "=== which dropbear ==="
Send-Cmd -stream $stream -cmd "which dropbear" | Write-Host
Write-Host "=== ls /media/developer/bin ==="
Send-Cmd -stream $stream -cmd "ls -la /media/developer/bin 2>&1" | Write-Host
Write-Host "=== ls /media/developer/etc/init.d ==="
Send-Cmd -stream $stream -cmd "ls -la /media/developer/etc/init.d 2>&1" | Write-Host
Write-Host "=== ps dropbear ==="
Send-Cmd -stream $stream -cmd "ps -ef | grep -i dropbear 2>&1; echo DONE" | Write-Host
Write-Host "=== listening ports ==="
Send-Cmd -stream $stream -cmd "netstat -tlnp 2>&1 | head -20; echo DONE" | Write-Host

$stream.Close()
$client.Close()