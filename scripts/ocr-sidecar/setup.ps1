# Instala el OCR local de Asistenta en scripts\ocr-sidecar\.venv (Windows PowerShell).
# Uso: scripts\ocr-sidecar\setup.ps1 [-Model ppocr|glm]
param([ValidateSet('ppocr', 'glm')][string]$Model = 'ppocr')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) { py -3 -m venv .venv }
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $py -m pip install --upgrade pip
if ($Model -eq 'glm') {
  & $py -m pip install torch --index-url https://download.pytorch.org/whl/cpu
}
& $py -m pip install -r "requirements-$Model.txt"
& $py ocr_sidecar.py --model $Model --check
Write-Host "Listo. En .env: PA_OCR_LOCAL=1 y PA_OCR_MODEL=$Model"
