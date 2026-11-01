#!/usr/bin/env bash
# Instala el OCR local de Asistenta en scripts/ocr-sidecar/.venv (Linux/WSL).
# Uso: scripts/ocr-sidecar/setup.sh [ppocr|glm]
set -euo pipefail
MODEL="${1:-ppocr}"
case "$MODEL" in ppocr|glm) ;; *) echo "Modelo: ppocr o glm" >&2; exit 2 ;; esac
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
PY=.venv/bin/python
"$PY" -m pip install --upgrade pip
if [ "$MODEL" = glm ]; then "$PY" -m pip install torch --index-url https://download.pytorch.org/whl/cpu; fi
"$PY" -m pip install -r "requirements-$MODEL.txt"
"$PY" ocr_sidecar.py --model "$MODEL" --check
echo "Listo. En .env: PA_OCR_LOCAL=1 y PA_OCR_MODEL=$MODEL"
