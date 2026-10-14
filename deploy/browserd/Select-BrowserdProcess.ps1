#requires -Version 5.1
# Helpers del autostart de browserd, separados para que los canarios
# (test-autostart-canaries.ps1) prueben la logica sin tocar el Planificador.

function Test-BrowserdCommandLine {
    param([string] $CommandLine)
    # Modulo EXACTO: `-m browserd` seguido de fin de linea o de separador.
    # Sin la frontera, `-m browserd_backup` u otros modulos prefijados tambien
    # casaban y el cleanup podia matar procesos ajenos (auditoria).
    return ($CommandLine -match '-m\s+browserd(\s|$)')
}

function Get-LauncherPythonPath {
    param([string] $Arguments)
    # Los Arguments de la accion que registra install-browserd-autostart.ps1 son
    #   "<launcher.vbs>" "<python.exe>" "<browserdDir>"
    # El python del venv que arranca la tarea es el SEGUNDO token quoted. Se usa
    # al reemplazar o quitar una tarea: el cleanup apunta al python que la
    # tarea VIEJA lanzaba, no al que toca ahora (auditoria).
    $tokens = [regex]::Matches($Arguments, '"([^"]+)"')
    if ($tokens.Count -lt 2) { return $null }
    return $tokens[1].Groups[1].Value
}
