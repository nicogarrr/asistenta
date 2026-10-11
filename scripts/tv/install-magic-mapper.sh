#!/bin/sh
# install-magic-mapper.sh - despliega magic_mapper v1.1.0 con staging en el MISMO
# fs de destino, validacion completa, backup total, stop->replace->start->verify
# y rollback automatico si algo falla despues del backup.
# PREFLIGHT DURO: exige el listener de la asistenta respondiendo; sin listener el
# boton no se activa (criterio del auditor, no negociable por doc).
# Uso: sh scripts/tv/install-magic-mapper.sh <ip-tv> <ip-laptop> [usuario]
set -eu
TV="${1:?uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> [usuario]}"
LAPTOP="${2:?falta la IP LAN del laptop (asistenta)}"
USER="${3:-root}"
VERSION="v1.1.0"
BASE="https://raw.githubusercontent.com/andrewfraley/magic_mapper/$VERSION"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)

# IP: 4 octetos 0-255 Y rango privado LAN.
O1=$(echo "$LAPTOP" | cut -d. -f1); O2=$(echo "$LAPTOP" | cut -d. -f2)
O3=$(echo "$LAPTOP" | cut -d. -f3); O4=$(echo "$LAPTOP" | cut -d. -f4)
case "$O1.$O2.$O3.$O4" in *[!0-9.]*|*..*|.*|*.) echo "IP mal formada: $LAPTOP"; exit 1;; esac
for o in "$O1" "$O2" "$O3" "$O4"; do [ "$o" -le 255 ] 2>/dev/null || { echo "octeto fuera de rango: $o"; exit 1; }; done
if [ "$O1" != "192" ] && [ "$O1" != "10" ] && [ "$O1" != "172" ]; then echo "IP no privada: $LAPTOP"; exit 1; fi

# PREFLIGHT DURO: listener de la asistenta vivo (health endpoint). Sin el, aborto.
curl -fsS -m 3 "http://$LAPTOP:8765/tv/button-health" >/dev/null 2>&1 \
  || { echo "listener :8765/tv/button-health NO responde en $LAPTOP - despliega primero la PR del listener; boton NO activado"; exit 2; }

CFG=$(mktemp)
trap rm -f  EXIT
sed "s|__ASISTENTA_URL__|http://$LAPTOP:8765/tv/button|" "$SCRIPT_DIR/../../config/tv/magic_mapper_config.json" > "$CFG"
python3 -m json.tool "$CFG" >/dev/null
grep -q "$LAPTOP" "$CFG"

# 1) STAGING en /home/root/.mm-new (MISMO fs que el destino home; init.d va aparte).
ssh "$USER@$TV" sh -s "$BASE" <<'REMOTE'
set -eu
BASE="$1"
[ -x /var/lib/webosbrew/init.d ] || mkdir -p /var/lib/webosbrew/init.d
command -v python3 >/dev/null || { echo "python3 no existe en la TV"; exit 1; }
[ -d /dev/input ] || { echo "/dev/input ausente (evdev)"; exit 1; }
rm -rf /home/root/.mm-new && mkdir -p /home/root/.mm-new
cd /home/root/.mm-new
wget -q "$BASE/magic_mapper.py" -O magic_mapper.py
wget -q "$BASE/magic_mapper_config.json" -O magic_mapper_config.json.dist
wget -q "$BASE/start_magic_mapper" -O start_magic_mapper.new
[ -s magic_mapper.py ] && [ -s magic_mapper_config.json.dist ] && [ -s start_magic_mapper.new ]
python3 -c "import ast; ast.parse(open(\"/home/root/.mm-new/magic_mapper.py\").read())"
# start_magic_mapper es SHELL: validar con el interprete que declara.
SHBIN=$(head -1 start_magic_mapper.new | tr -d "\r" | sed "s/^#!//")
[ -x "$SHBIN" ] || { echo "interprete $SHBIN no existe en la TV"; exit 1; }
"$SHBIN" -n start_magic_mapper.new || { echo "start_magic_mapper no parsea con $SHBIN"; exit 1; }
REMOTE
ssh "$USER@$TV" "cat > /home/root/.mm-new/magic_mapper_config.json" < "$CFG"
ssh "$USER@$TV" "python3 -m json.tool /home/root/.mm-new/magic_mapper_config.json >/dev/null"

# 2) BACKUP TOTAL (falla ruidoso) -> STOP -> REPLACE -> START -> VERIFY; rollback auto.
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
TS=$(date +%Y%m%d-%H%M%S)
BK=/home/root/mm-backup-$TS
mkdir -p "$BK"
# Backup de TODO lo que puede existir (incluye .dist); falla ruidoso si cp falla.
for f in /home/root/magic_mapper.py /home/root/magic_mapper_config.json /home/root/magic_mapper_config.json.dist /var/lib/webosbrew/init.d/start_magic_mapper; do
  if [ -e "$f" ]; then cp -a "$f" "$BK/" || { echo "backup fallo en $f"; exit 1; }; fi
done
restore() {
  [ -e /home/root/magic_mapper.py ] && rm -f /home/root/magic_mapper.py
  [ -e /home/root/magic_mapper_config.json ] && rm -f /home/root/magic_mapper_config.json
  [ -e /home/root/magic_mapper_config.json.dist ] && rm -f /home/root/magic_mapper_config.json.dist
  [ -e /var/lib/webosbrew/init.d/start_magic_mapper ] && rm -f /var/lib/webosbrew/init.d/start_magic_mapper
  for b in "$BK"/*; do
    [ -e "$b" ] || continue
    case "$b" in
      */start_magic_mapper) cp -a "$b" /var/lib/webosbrew/init.d/start_magic_mapper ;;
      *) cp -a "$b" "/home/root/$(basename "$b")" ;;
    esac
  done
  /var/lib/webosbrew/init.d/start_magic_mapper start 2>/dev/null || true
}
/var/lib/webosbrew/init.d/start_magic_mapper stop 2>/dev/null || true
mv /home/root/.mm-new/magic_mapper.py /home/root/magic_mapper.py
mv /home/root/.mm-new/magic_mapper_config.json /home/root/magic_mapper_config.json
mv /home/root/.mm-new/magic_mapper_config.json.dist /home/root/magic_mapper_config.json.dist
mv /home/root/.mm-new/start_magic_mapper.new /var/lib/webosbrew/init.d/start_magic_mapper
chmod +x /var/lib/webosbrew/init.d/start_magic_mapper
rm -rf /home/root/.mm-new
/var/lib/webosbrew/init.d/start_magic_mapper start || { echo "start fallo - ROLLBACK"; restore; exit 1; }
sleep 2
# VERIFY: proceso python vivo con nuestro script.
if pgrep -f magic_mapper.py >/dev/null 2>&1; then
  echo "magic_mapper: DESPLEGADO Y PROCESO VIVO (backup en $BK)"
else
  echo "proceso no vivo tras start - ROLLBACK"; restore; exit 1
fi
REMOTE
echo "Rollback manual ejecutable: ssh $USER@$TV \"/var/lib/webosbrew/init.d/start_magic_mapper stop; BK=<dir impreso arriba>; for b in \$BK/*; do cp -a \$b /home/root/; done; cp -a \$BK/start_magic_mapper /var/lib/webosbrew/init.d/ 2>/dev/null; /var/lib/webosbrew/init.d/start_magic_mapper start\""
