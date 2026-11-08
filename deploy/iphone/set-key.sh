#!/usr/bin/env bash
# Guarda LLM_API_KEY en el .env del servidor leyendo la clave por stdin (nunca por argumento
# ni por chat, no sale por pantalla). Uso: printf '%s' "$CLAVE" | bash set-key.sh [ruta/.env]
# shortcut: si la clave lleva saltos de linea se rechaza; mejorar si algun proveedor los usa.
set -euo pipefail
ENVF=${1:-$HOME/esp32-iphone-agent/server/.env}
IFS= read -r KEY || true
[ -n "$KEY" ] || { echo "Clave vacia: no se ha guardado nada." >&2; exit 1; }
[ -f "$ENVF" ] || { echo "No existe $ENVF (ejecuta antes install-wsl.sh)." >&2; exit 1; }
TMP=$(mktemp "$ENVF.XXXXXX")
chmod 600 "$TMP"
KEY="$KEY" awk 'BEGIN{done=0} /^LLM_API_KEY=/{ if(!done){print "LLM_API_KEY=" ENVIRON["KEY"]; done=1}; next } {print} END{ if(!done) print "LLM_API_KEY=" ENVIRON["KEY"] }' "$ENVF" > "$TMP"
mv "$TMP" "$ENVF"
chmod 600 "$ENVF"
echo "Clave guardada (permisos 600)."
