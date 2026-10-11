#!/bin/sh
# install-magic-mapper.sh - despliega magic_mapper v1.1.0 con staging + validacion
# + backup + reemplazo atomico. NADA se escribe sobre destinos vivos sin validar.
# Uso: sh scripts/tv/install-magic-mapper.sh <ip-tv> <ip-laptop> [usuario]
set -eu
TV="${1:?uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> [usuario]}"
LAPTOP="${2:?falta la IP LAN del laptop (asistenta)}"
USER="${3:-root}"
VERSION="v1.1.0"
BASE="https://raw.githubusercontent.com/andrewfraley/magic_mapper/$VERSION"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)

# IP estricta: 4 octetos numericos, nada de metacaracteres.
echo "$LAPTOP" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo "IP laptop mal formada: $LAPTOP"; exit 1; }

# Render de la config LOCAL + validacion JSON antes de subir nada.
CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT
sed "s|__ASISTENTA_URL__|http://$LAPTOP:8765/tv/button|" "$SCRIPT_DIR/../../config/tv/magic_mapper_config.json" > "$CFG"
python3 -m json.tool "$CFG" >/dev/null || { echo "config renderizada no es JSON valido"; exit 1; }
grep -q "$LAPTOP" "$CFG" || { echo "el render no sustituyo la URL"; exit 1; }

# 1) STAGING en temporal: los wgets pueden fallar a medias sin tocar lo vivo.
ssh "$USER@$TV" sh -s "$BASE" <<'REMOTE'
set -eu
BASE="$1"
rm -rf /tmp/mm-new && mkdir -p /tmp/mm-new
cd /tmp/mm-new
for f in magic_mapper.py magic_mapper_config.json.dist start_magic_mapper; do :; done
wget -q "$BASE/magic_mapper.py" -O magic_mapper.py
wget -q "$BASE/magic_mapper_config.json" -O magic_mapper_config.json.dist
wget -q "$BASE/start_magic_mapper" -O start_magic_mapper
# Validacion: ficheros no vacios y el python parsea.
[ -s magic_mapper.py ] && [ -s start_magic_mapper ] && [ -s magic_mapper_config.json.dist ]
python3 -c "import ast,sys; ast.parse(open('/tmp/mm-new/magic_mapper.py').read())" || { echo "magic_mapper.py no parsea"; exit 1; }
REMOTE
# 2) Nuestra config validada -> staging (cat por ssh: C2 no soporta scp).
ssh "$USER@$TV" "cat > /tmp/mm-new/magic_mapper_config.json" < "$CFG"
ssh "$USER@$TV" "python3 -m json.tool /tmp/mm-new/magic_mapper_config.json >/dev/null" || { echo "config corrupta en destino"; exit 1; }
# 3) BACKUP de lo vivo + reemplazo (mismo fs = mv atomico por fichero).
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
TS=$(date +%Y%m%d-%H%M%S)
BK=/home/root/mm-backup-$TS
mkdir -p "$BK"
for f in /home/root/magic_mapper.py /home/root/magic_mapper_config.json /var/lib/webosbrew/init.d/start_magic_mapper; do
  [ -e "$f" ] && cp -a "$f" "$BK/" || true
done
mv /tmp/mm-new/magic_mapper.py /home/root/magic_mapper.py
mv /tmp/mm-new/magic_mapper_config.json /home/root/magic_mapper_config.json
mv /tmp/mm-new/magic_mapper_config.json.dist /home/root/magic_mapper_config.json.dist
mv /tmp/mm-new/start_magic_mapper /var/lib/webosbrew/init.d/start_magic_mapper
chmod +x /var/lib/webosbrew/init.d/start_magic_mapper
rm -rf /tmp/mm-new
/var/lib/webosbrew/init.d/start_magic_mapper restart 2>/dev/null || /var/lib/webosbrew/init.d/start_magic_mapper start
echo "magic_mapper: DESPLEGADO (backup en $BK)"
REMOTE
echo "magic_mapper instalado en $TV (webhook -> http://$LAPTOP:8765/tv/button)"
echo "Rollback: ssh $USER@$TV '/var/lib/webosbrew/init.d/start_magic_mapper stop; cp -a <backup>/* a sus rutas; start'"
