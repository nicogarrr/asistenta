$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.1.237', 23)
$stream = $client.GetStream()

function Read-All {
    param($stream, [int]$waitMs = 1500)
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

# Check for existing tailscale
Write-Host "=== existing tailscale ==="
Send-Cmd -stream $stream -cmd "ls -la /media/developer/bin/ 2>&1; which tailscale 2>/dev/null; which tailscaled 2>/dev/null; ls /var/run/tailscale 2>/dev/null; echo DONE" | Write-Host

# Check listening services (any "Glasshouse" related)
Write-Host "=== listening services ==="
Send-Cmd -stream $stream -cmd "netstat -tln 2>&1 | head -30; echo DONE" | Write-Host

# Test outbound DNS resolution (to ensure pkgs.tailscale.com is reachable)
Write-Host "=== outbound connectivity ==="
Send-Cmd -stream $stream -cmd "wget -q -O - --timeout=15 https://pkgs.tailscale.com/stable/tailscale_1.104.1_arm64.tgz.sha256 2>&1; echo DONE" | Write-Host

$stream.Close()
$client.Close()