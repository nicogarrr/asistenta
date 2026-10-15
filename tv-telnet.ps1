# PowerShell telnet client for the LG C5 TV
$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.1.237', 23)
$stream = $client.GetStream()
$reader = New-Object System.IO.StreamReader $stream
$writer = New-Object System.IO.StreamWriter $stream
$writer.AutoFlush = $true

# Wait for login prompt
Start-Sleep -Milliseconds 1500
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

# Try sending an empty line to confirm we're at a shell
$writer.WriteLine("")
Start-Sleep -Milliseconds 800
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

# Send uname
$writer.WriteLine("uname -a")
Start-Sleep -Milliseconds 800
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

# Send arch
$writer.WriteLine("uname -m")
Start-Sleep -Milliseconds 600
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

# Check /dev/net/tun
$writer.WriteLine("ls -la /dev/net/tun 2>&1")
Start-Sleep -Milliseconds 600
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

# Check webOS release
$writer.WriteLine("cat /etc/starfish-release 2>&1 | head -5")
Start-Sleep -Milliseconds 600
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

# Check whoami and pwd
$writer.WriteLine("whoami; pwd; id")
Start-Sleep -Milliseconds 600
while ($reader.Peek() -ge 0) {
    $line = $reader.ReadLine()
    Write-Host $line
}

$client.Close()