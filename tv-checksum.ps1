$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.1.237', 23)
$stream = $client.GetStream()

function Read-All {
    param($stream, [int]$waitMs = 2000)
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
    param($stream, [string]$cmd, [int]$waitMs = 2000)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
    return Read-All -stream $stream -waitMs $waitMs
}

Read-All -stream $stream -waitMs 1500 | Out-Null

# Simple checksum check using awk
Write-Host "=== checksum ==="
Send-Cmd -stream $stream -cmd "cd /tmp && HASH=`$(sha256sum tailscale_1.104.1_arm64.tgz | awk '{print `$1}'); EXPECTED=f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806; echo computed=$HASH; echo expected=$EXPECTED; if [ \"$HASH\" = \"$EXPECTED\" ]; then echo MATCH; else echo MISMATCH; fi" | Write-Host

# Check tailscaled can run
Write-Host "=== tailscaled --help ==="
Send-Cmd -stream $stream -cmd "/media/developer/bin/tailscaled --help 2>&1 | head -40; echo DONE" | Write-Host

# Check capabilities / lib paths
Write-Host "=== ldd ==="
Send-Cmd -stream $stream -cmd "ldd /media/developer/bin/tailscaled 2>&1; echo --; ldd /media/developer/bin/tailscale 2>&1; echo DONE" | Write-Host

# Clean up /tmp
Write-Host "=== cleanup ==="
Send-Cmd -stream $stream -cmd "rm -rf /tmp/tailscale_1.104.1_arm64 /tmp/expected.sha256 && df -h /tmp /var /media; echo DONE" | Write-Host

$stream.Close()
$client.Close()