#!/usr/bin/env bash
# Instala el servidor hidagent (esp32-iphone-agent) en Ubuntu/Debian o WSL2.
# NO necesita la ESP32 conectada. No escribe ninguna clave.
# Uso: bash deploy/iphone/install-wsl.sh [directorio]   (por defecto ~/esp32-iphone-agent)
set -euo pipefail

# Version fijada: el codigo de arriba se ha leido y probado contra este commit.
UPSTREAM=https://github.com/onehumanbeing/esp32-iphone-agent
PIN=88a51030b5ec36564157bc778c7827b4dffb4b41
DEST=${1:-$HOME/esp32-iphone-agent}
HERE=$(cd "$(dirname "$0")" && pwd)

command -v apt-get >/dev/null || { echo "Hace falta apt (Ubuntu/Debian/WSL)." >&2; exit 1; }
sudo apt-get update -y
sudo apt-get install -y git python3 python3-venv python3-pip curl \
  uxplay avahi-daemon libnss-mdns \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav

# UxPlay anuncia el receptor por mDNS: necesita avahi corriendo.
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  sudo systemctl enable --now avahi-daemon
else
  echo "AVISO: sin systemd no arranca avahi. En WSL2 activa systemd (ver README: /etc/wsl.conf)." >&2
fi

if [ ! -d "$DEST/.git" ]; then git clone "$UPSTREAM" "$DEST"; fi
git -C "$DEST" fetch -q origin
git -C "$DEST" checkout -q "$PIN"
test "$(git -C "$DEST" rev-parse HEAD)" = "$PIN"

cd "$DEST/server"
python3 -m venv .venv
.venv/bin/pip install -q -e .
if [ ! -f .env ]; then
  cp "$HERE/env.example" .env
  chmod 600 .env
  echo "Creado $DEST/server/.env: edita LLM_API_KEY (no se ha escrito ninguna clave)."
fi
echo "OK. Arranca con: bash $HERE/run.sh $DEST"
