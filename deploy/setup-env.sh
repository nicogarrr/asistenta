#!/usr/bin/env bash
# Crea el archivo de secretos (permisos 600) pidiendo los valores sin eco.
# Uso: bash deploy/setup-env.sh [ruta]   (por defecto ~/asistenta.env)
set -euo pipefail
file="${1:-$HOME/asistenta.env}"
umask 077
ask() { # nombre, etiqueta
  local v
  read -r -s -p "$2: " v </dev/tty
  echo >/dev/tty
  [ -n "$v" ] || { echo "valor vacío" >&2; exit 1; }
  case "$v" in *$'\n'*|*'"'*) echo "valor inválido" >&2; exit 1;; esac
  printf '%s=%s\n' "$1" "$v"
}
{
  ask PA_SECRET_TELEGRAM_BOTTOKEN "Token del bot de Telegram"
  ask PA_SECRET_PROVIDER_APIKEY "API key de OpenCode Zen"
  ask PA_SECRET_TELEGRAM_ALLOWEDUSERIDS "Tu user ID numérico de Telegram"
} > "$file.tmp"
mv "$file.tmp" "$file"
chmod 600 "$file"
echo "Guardado en $file (600)."
