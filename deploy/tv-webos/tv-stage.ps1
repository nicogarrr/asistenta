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

# Re-download the sha256 for verification
Write-Host "=== sha256 verify ==="
$verifyScript = @'
cd /tmp
HASH=$(sha256sum tailscale_1.104.1_arm64.tgz | awk '{print $1}')
EXPECTED=$(wget -q -O - https://pkgs.tailscale.com/stable/tailscale_1.104.1_arm64.tgz.sha256)
echo "computed=$HASH"
echo "expected=$EXPECTED"
if [ "$HASH" = "$EXPECTED" ]; then echo MATCH_OK; else echo MISMATCH; fi
'@
$r = Send-Cmd -stream $stream -cmd $verifyScript -waitMs 15000
Write-Host $r

# Check init.d directory for what's there (but we won't install there yet)
Write-Host "=== existing services ==="
$r = Send-Cmd -stream $stream -cmd "ls -la /etc/init.d/ 2>&1 | head; echo --; ls -la /media/developer/etc 2>&1; echo DONE" -waitMs 3000
Write-Host $r

# Check webOS version / capabilities
Write-Host "=== capabilities check ==="
$r = Send-Cmd -stream $stream -cmd "getcap /media/developer/bin/tailscaled 2>&1; ls -la /dev/net/tun; echo --; lsmod 2>/dev/null | grep tun; echo DONE" -waitMs 3000
Write-Host $r

$stream.Close()
$client.Close()