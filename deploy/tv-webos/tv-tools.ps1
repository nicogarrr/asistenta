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
    param($stream, [string]$cmd, [int]$waitMs = 1500)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd + "`r`n")
    $stream.Write($bytes, 0, $bytes.Length)
    return Read-All -stream $stream -waitMs $waitMs
}

Read-All -stream $stream -waitMs 1500 | Out-Null

Write-Host "=== individual which ==="
foreach ($t in @("wget","curl","nc","netcat","socat","dropbear","sshd","scp","base64","sha256sum","sha1sum","md5sum","openssl","busybox","ash","awk","sed","dd","tar","gunzip","gzip","hexdump")) {
    $r = Send-Cmd -stream $stream -cmd "which $t 2>/dev/null" -waitMs 400
    $r = $r.Trim() -replace "~ # ", "" -replace "`n", ""
    if ($r -match "/") {
        Write-Host "$t = $r"
    } else {
        Write-Host "$t = MISSING"
    }
}

Write-Host "=== busybox applets ==="
$r = Send-Cmd -stream $stream -cmd "busybox --list 2>&1 | tr ' ' '\n' | sort -u" -waitMs 1500
Write-Host $r

Write-Host "=== developer dir ==="
$r = Send-Cmd -stream $stream -cmd "ls -la /media/developer/ 2>&1" -waitMs 1200
Write-Host $r

Write-Host "=== memory ==="
$r = Send-Cmd -stream $stream -cmd "free -h 2>&1" -waitMs 1000
Write-Host $r

$stream.Close()
$client.Close()