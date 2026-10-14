#requires -Version 5.1
<#
.SYNOPSIS
  Detecta si un .env contiene valores quoted multilinea.

.DESCRIPTION
  dotenv (y util.parseEnv de Node) admiten valores entre comillas que ocupan
  varias lineas, con TRES delimitadores posibles: dobles, simples y backtick. Un editor que filtra por lineas destruiria ese valor si una
  de las lineas internas parece una asignacion (canario del auditor:
  PROMPT="first line\nBROWSER_ENGINE=inside-prompt\nlast line").
  Este scanner recorre el archivo consciente del estado de comillas:
  devuelve $true si alguna comilla no se cierra en su propia linea (valor
  multilinea real o comilla impar - ambos casos se tratan como "no tocar").
  Conservador a proposito: un falso positivo solo pide edicion manual; un
  falso negativo corrompe el .env del usuario.
#>
function Test-MultilineQuoted {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Lines
  )
  $inQuote = $null
  foreach ($l in $Lines) {
    for ($i = 0; $i -lt $l.Length; $i++) {
      $c = $l[$i]
      if ($inQuote) {
        if ($c -eq $inQuote) {
          # Dentro de dobles comillas, \" no cierra el valor.
          if ($inQuote -eq '"' -and $i -gt 0 -and $l[$i - 1] -eq '\') { continue }
          $inQuote = $null
        }
      } elseif ($c -eq '"' -or $c -eq "'" -or $c -eq [char]96) {
        # Node (util.parseEnv/dotenv) admite TRES delimitadores: ", ' y
        # backtick (char 96). El backtick tambien abre valor multilinea.
        $inQuote = $c
      } elseif ($c -eq '#') {
        break  # comentario fuera de comillas: el resto de la linea no cuenta
      }
    }
    # Una comilla abierta al terminar la linea = valor multilinea (o comilla
    # impar): en ambos casos el archivo NO se toca. Se comprueba POR LINEA:
    # esperar al final del archivo dejaria escapar un valor que cierra tres
    # lineas despues (el canario del auditor).
    if ($null -ne $inQuote) { return $true }
  }
  return $false
}
