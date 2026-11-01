<# Icono de Asistenta junto al reloj (bandeja del sistema). Sin consolas: lo abre
   asistenta.vbs oculto. Habla con Asistenta solo con sus propias órdenes en este PC
   (pa status, pa stop, pa iniciar); no lee claves ni el token del panel, y no pasa
   secretos en la línea de órdenes. El panel se abre solo en 127.0.0.1. #>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$app = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$node = Join-Path (Split-Path $app -Parent) 'node\node.exe'
# Instalación con instalar.bat (sin Node dentro): el Node del PATH.
if (-not (Test-Path -LiteralPath $node)) { $node = 'node.exe' }
$stateDir = if ($env:PA_STATE_DIR) { $env:PA_STATE_DIR } else { Join-Path $env:USERPROFILE '.local\share\personal-agent' }
$tarea = 'personal-agent-daemon'
# La línea siguiente a esta ruta no puede empezar por variable: el filtro de seguridad lo tomaría por una orden escondida.
$cli = Join-Path $app 'dist\cli.js'

# Un solo icono por usuario.
$mutex = New-Object System.Threading.Mutex($false, 'Local\AsistentaBandeja')
if (-not $mutex.WaitOne(0)) { exit 0 }

# Las órdenes de cada opción del menú (siempre las de pa, nunca otras).
$Ordenes = @{
    Estado  = @('status', '--json')
    Texto   = @('status')
    Pausar  = @('stop')
    Encender = @('iniciar')
    Panel   = @('panel')
}

function Invoke-Pa([string[]] $Orden) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '"' + $cli + '" ' + ($Orden -join ' ')
    $psi.WorkingDirectory = $app
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    try { $p = [Diagnostics.Process]::Start($psi) } catch { return [pscustomobject]@{ Code = 1; Text = 'No encuentro Node para hablar con Asistenta.' } }
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(90000)) { try { $p.Kill() } catch {}; return [pscustomobject]@{ Code = 1; Text = 'Asistenta no ha contestado a tiempo.' } }
    [pscustomobject]@{ Code = $p.ExitCode; Text = ($out.Result + $err.Result).Trim() }
}

# Verde: en marcha y conectada a Telegram; ámbar: en marcha pero sin Telegram; rojo: parada.
function Get-Estado {
    $r = Invoke-Pa $Ordenes.Estado
    try { $s = $r.Text | ConvertFrom-Json } catch { return 'rojo' }
    if (-not ($s.processState -eq 'alive' -and $s.heartbeatState -eq 'fresh')) { return 'rojo' }
    if ($s.telegram -eq 'conectada') { return 'verde' }
    return 'ambar'
}

# Encender: con el arranque automático instalado, por su tarea (así la vigila); si no,
# pa iniciar oculto. Asistenta no deja que corran dos a la vez.
function Start-Asistenta {
    $t = Get-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($t) { Start-ScheduledTask -InputObject $t; return }
    Start-Process -FilePath $node -ArgumentList (@("`"$cli`"") + $Ordenes.Encender) -WorkingDirectory $app -WindowStyle Hidden
}

# El logo de Asistenta sin su punto azul (bandeja.ico) y, en su esquina, el punto de estado
# con un aro grafito que lo separa de la «A». Al tamaño de icono pequeño de Windows (16 px al
# 100 %, 20 al 125 %, 24 al 150 %), así no se ve borroso con la escala. Sin bandeja.ico usa
# asistenta.ico; instalada con instalar.bat no hay icono y queda solo el punto.
$appIco = Join-Path (Split-Path $app -Parent) 'asistenta.ico'
$trayIco = Join-Path (Split-Path $app -Parent) 'bandeja.ico'
if (-not (Test-Path -LiteralPath $trayIco)) { $trayIco = $appIco }
$tam = [Math]::Max(16, [System.Windows.Forms.SystemInformation]::SmallIconSize.Width)
$k = [single]($tam / 16)
function New-Punto([System.Drawing.Color] $color) {
    $bmp = New-Object System.Drawing.Bitmap $tam, $tam
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    if (Test-Path -LiteralPath $trayIco) {
        $base = New-Object System.Drawing.Icon($trayIco, $tam, $tam)
        $g.DrawIcon($base, (New-Object System.Drawing.Rectangle 0, 0, $tam, $tam))
        $aro = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(17, 24, 39))
        $g.FillEllipse($aro, [single](8 * $k), [single](8 * $k), [single](9 * $k), [single](9 * $k))
        $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), [single](9 * $k), [single](9 * $k), [single](7 * $k), [single](7 * $k))
    } else {
        $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), $k, $k, [single](14 * $k), [single](14 * $k))
    }
    $g.Dispose()
    [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$verde = New-Punto ([System.Drawing.Color]::FromArgb(40, 167, 69))
$rojo = New-Punto ([System.Drawing.Color]::FromArgb(220, 53, 69))
$ambar = New-Punto ([System.Drawing.Color]::FromArgb(255, 193, 7))
$naranja = New-Punto ([System.Drawing.Color]::FromArgb(253, 126, 20))

$icono = New-Object System.Windows.Forms.NotifyIcon
$icono.Icon = $rojo
$icono.Text = 'Asistenta'
$icono.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:enMarcha = $false
$script:color = 'rojo'

function Update-Estado {
    # Desinstalada: el icono se va solo.
    if (-not (Test-Path -LiteralPath $cli)) { $icono.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }
    $script:color = Get-Estado
    $script:enMarcha = $script:color -ne 'rojo'
    $icono.Icon = switch ($script:color) { 'verde' { $verde } 'ambar' { $ambar } default { $rojo } }
    $icono.Text = switch ($script:color) { 'verde' { 'Asistenta: en marcha' } 'ambar' { 'Asistenta: en marcha, sin Telegram' } default { 'Asistenta: parada' } }
    $pausa.Text = if ($script:enMarcha) { 'Pausar' } else { 'Reanudar' }
}

function Show-Aviso([string] $texto) {
    $icono.ShowBalloonTip(5000, 'Asistenta', $texto, 'Info')
}

$abrir = $menu.Items.Add('Abrir panel')
$abrir.add_Click({
    # pa panel abre el panel en el navegador ya con el token: la bandeja no lo lee nunca.
    $r = Invoke-Pa $Ordenes.Panel
    if ($r.Code -ne 0) { Show-Aviso $r.Text }
})
$pausa = $menu.Items.Add('Pausar / Reanudar')
$pausa.add_Click({
    if ($script:enMarcha) { [void](Invoke-Pa $Ordenes.Pausar); Show-Aviso 'Asistenta en pausa.' }
    else { Start-Asistenta; Show-Aviso 'Encendiendo Asistenta…' }
    Start-Sleep -Seconds 3
    Update-Estado
})
$reiniciar = $menu.Items.Add('Reiniciar')
$reiniciar.add_Click({
    [void](Invoke-Pa $Ordenes.Pausar)
    Start-Asistenta
    Show-Aviso 'Reiniciando Asistenta…'
    Start-Sleep -Seconds 5
    Update-Estado
})
$estado = $menu.Items.Add('Ver estado')
$estado.add_Click({
    Update-Estado
    $r = Invoke-Pa $Ordenes.Texto
    $tipo = if ($script:color -eq 'verde') { 'Information' } else { 'Warning' }
    $cabeza = switch ($script:color) { 'verde' { '🟢 En marcha y conectada a Telegram' } 'ambar' { '🟡 En marcha, pero sin conexión con Telegram' } default { '🔴 Parada o sin dar señales' } }
    [void][System.Windows.Forms.MessageBox]::Show("$cabeza`n`n$($r.Text)", 'Estado de Asistenta', 'OK', $tipo)
})
$registro = $menu.Items.Add('Ver registro')
$registro.add_Click({
    $log = Join-Path $stateDir 'log'
    if (Test-Path -LiteralPath $log) { Start-Process explorer.exe -ArgumentList "`"$log`"" }
    else { Show-Aviso 'Aún no hay registro: aparece cuando Asistenta arranca.' }
})
[void]$menu.Items.Add('-')
$salir = $menu.Items.Add('Salir')
$salir.add_Click({
    [void](Invoke-Pa $Ordenes.Pausar)
    $icono.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$icono.ContextMenuStrip = $menu
$icono.add_DoubleClick({ $estado.PerformClick() })

# Gancho para el dictado (dictado-1): mientras exista este archivo, el punto se pone
# naranja («grabando»). Solo se mira si existe; no se lee nada de dentro.
$grabando = Join-Path $stateDir 'dictado.grabando'
$rapido = New-Object System.Windows.Forms.Timer
$rapido.Interval = 1000
$rapido.add_Tick({ if (Test-Path -LiteralPath $grabando) { $icono.Icon = $naranja } elseif ($icono.Icon -eq $naranja) { Update-Estado } })
$rapido.Start()

$lento = New-Object System.Windows.Forms.Timer
$lento.Interval = 60000
$lento.add_Tick({ Update-Estado })
$lento.Start()

# Al abrir: si Asistenta no está en marcha, se da un margen a la tarea de arranque
# automático (al encender el PC) y, si sigue parada, se enciende.
Update-Estado
if (-not $script:enMarcha) {
    for ($i = 0; $i -lt 6 -and -not $script:enMarcha; $i++) { Start-Sleep -Seconds 5; Update-Estado }
    if (-not $script:enMarcha) { Start-Asistenta; Start-Sleep -Seconds 5; Update-Estado }
}
[System.Windows.Forms.Application]::Run()
$icono.Dispose()
$mutex.ReleaseMutex()
