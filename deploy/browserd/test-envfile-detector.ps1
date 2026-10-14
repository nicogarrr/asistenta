#requires -Version 5.1
# Bateria de fixtures para Test-MultilineQuoted. Exit 0 si todo coincide.
# Uso: pwsh -File deploy/browserd/test-envfile-detector.ps1
. (Join-Path $PSScriptRoot 'Test-MultilineQuoted.ps1')

$script:fail = 0
function Check([string]$name, [string[]]$lines, [bool]$expected) {
  $got = Test-MultilineQuoted $lines
  if ($got -ne $expected) {
    Write-Host "FAIL $name (esperaba $expected, salio $got)"
    $script:fail = 1
  } else {
    Write-Host "ok   $name"
  }
}

# El canario del auditor: la linea intermedia parece una asignacion de
# BROWSER_ENGINE pero vive dentro del valor quoted de PROMPT.
Check 'canario auditor: multilinea quoted' @(
  'PROMPT="first line',
  'BROWSER_ENGINE=inside-prompt',
  'last line"'
) $true

Check 'simple sin comillas' @('A=1', 'BROWSER_ENGINE=playwright') $false
Check 'quoted de una linea' @('A="x"', "B='y z'") $false
Check 'comilla simple impar (conservador)' @("NAME=don't") $true
Check 'comillas dentro de comentario' @('# un "comentario" con comillas', 'A=1') $false
Check 'comillas escapadas dentro de dobles' @('A="dijo \"hola\" y cerro"', 'B=2') $false
Check 'multilinea con comillas simples' @("TXT='uno", "dos'") $true
Check 'multilinea con backtick (tercer delimitador Node)' @(
  'PROMPT=`first line',
  'BROWSER_ENGINE=inside-prompt',
  'last line`'
) $true

if ($script:fail -ne 0) { exit 1 }
Write-Host 'TODOS LOS FIXTURES OK'
