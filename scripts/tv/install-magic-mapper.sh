#!/bin/sh
# install-magic-mapper.sh - instala andrewfraley/magic_mapper v1.1.0 (version fijada)
# y despliega nuestra config. Uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> [usuario]
# <ip-laptop> es la IP LAN del PC de Nico donde corre la asistenta (webhook del boton).
set -eu
TV="${1:?uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> [usuario]}"
LAPTOP="${2:?falta la IP LAN del laptop (asistenta)}"
USER="${3:-root}"
VERSION="v1.1.0"
BASE="https://raw.githubusercontent.com/andrewfraley/magic_mapper/$VERSION"
ssh "$USER@$TV" sh -s <<REMOTE
set -eu
cd /home/root
wget -q "$BASE/magic_mapper.py" -O magic_mapper.py
wget -q "$BASE/magic_mapper_config.json" -O magic_mapper_config.json.dist
cd /var/lib/webosbrew/init.d
wget -q "$BASE/start_magic_mapper" -O start_magic_mapper
chmod +x /var/lib/webosbrew/init.d/start_magic_mapper
REMOTE
# Nuestra config: boton -> webhook de la asistenta. Se renderiza con la IP real.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sed "s/__ASISTENTA_URL__/http:\/\/$LAPTOP:8765\/tv\/button/" "$SCRIPT_DIR/../../config/tv/magic_mapper_config.json" \
  | ssh "$USER@$TV" "cat > /home/root/magic_mapper_config.json"
ssh "$USER@$TV" "/var/lib/webosbrew/init.d/start_magic_mapper restart || /var/lib/webosbrew/init.d/start_magic_mapper start"
echo "magic_mapper instalado y arrancado en $TV (webhook -> $LAPTOP:8765/tv/button)"
