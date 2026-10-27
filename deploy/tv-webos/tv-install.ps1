$TvIp = if ($env:TV_IP) { $env:TV_IP } else { '192.168.1.237' }
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect($TvIp, 23)
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

# Check /var state and check disk
Write-Host "=== /var state ==="
Send-Cmd -stream $stream -cmd "ls -la /var/lib 2>&1 | head; df -h /var /tmp /media 2>&1; echo DONE" | Write-Host

# Download the tgz
Write-Host "=== downloading tailscale ==="
Send-Cmd -stream $stream -cmd "cd /tmp && wget -q https://pkgs.tailscale.com/stable/tailscale_1.104.1_arm64.tgz && ls -la tailscale_1.104.1_arm64.tgz && echo DOWNLOAD_OK" -waitMs 45000 | Write-Host

# Verify checksum
Write-Host "=== verifying checksum ==="
Send-Cmd -stream $stream -cmd "cd /tmp && sha256sum tailscale_1.104.1_arm64.tgz && wget -q -O - https://pkgs.tailscale.com/stable/tailscale_1.104.1_arm64.tgz.sha256 | tr -d '\n' > /tmp/expected.sha256 && cat /tmp/expected.sha256 && if [ \"\$(sha256sum tailscale_1.104.1_arm64.tgz | awk '{print \$1}')\" = \"\$(cat /tmp/expected.sha256)\" ]; then echo MATCH; else echo MISMATCH; fi" | Write-Host

# Extract
Write-Host "=== extracting ==="
Send-Cmd -stream $stream -cmd "cd /tmp && tar -xzf tailscale_1.104.1_arm64.tgz && ls -la tailscale_1.104.1_arm64/ && cp tailscale_1.104.1_arm64/tailscale tailscale_1.104.1_arm64/tailscaled /media/developer/bin/ && ls -la /media/developer/bin/ && /media/developer/bin/tailscale --version && echo EXTRACT_OK" | Write-Host

$stream.Close()
$client.Close()