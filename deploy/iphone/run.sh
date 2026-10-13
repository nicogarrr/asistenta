#!/usr/bin/env bash
# Arranca el servidor hidagent. Uso: bash deploy/iphone/run.sh [directorio]
set -euo pipefail
DEST=${1:-$HOME/esp32-iphone-agent}
cd "$DEST/server"
[ -f .env ] || { echo "Falta $DEST/server/.env (ejecuta install-wsl.sh)." >&2; exit 1; }
command -v uxplay >/dev/null || { echo "Falta uxplay (ejecuta install-wsl.sh)." >&2; exit 1; }
grep -Eq '^LLM_API_KEY=.+' .env || { echo "LLM_API_KEY esta vacia en $DEST/server/.env." >&2; exit 1; }
set -a; . ./.env; set +a
echo "Interfaz web: http://$(hostname -I | awk '{print $1}'):${PORT:-8890}"
exec .venv/bin/python -m hidagent
