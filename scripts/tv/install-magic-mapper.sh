#!/bin/sh
# install-magic-mapper.sh - despliega magic_mapper v1.1.0. R6:
# - rollback generado desde templates/mapper-rollback.sh (test mock local):
#   stop sin ||true, guard no-vivo antes de tocar ficheros, restore visible;
# - rollback script verificado ANTES de mutar; stop del servicio viejo confirmado
#   no-vivo antes del rename;
# - --button validado contra la lista v1.1.0 (fuente: magic_mapper.py BUTTONS)
#   con magic_mapper_settings rechazado como reservado;
# - staging en el fs propio de cada destino; rollback automatico en fallo
#   post-backup (lo que el codigo garantiza: nada mas).
# - pgrep exigido en preflight (sin el, deploy/rollback no pueden verificar).
# Uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> --button <nombre> [usuario]
set -eu
TV="${1:?uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> --button <nombre> [usuario]}"
LAPTOP="${2:?falta la IP LAN del laptop (asistenta)}"
BTN=""
[ "${3:-}" = "--button" ] && BTN="${4:-}"
USER="${5:-root}"
KNOWN=" red green yellow blue ch_up ch_down vol_up vol_down play pause stop record rewind fastforward 1 2 3 4 5 6 7 8 9 0 prime sling netflix disney lg_channels rakuten alexa google guide voice channels channels_alt search search_alt exit sap tv info home "
case "$KNOWN" in *" $BTN "*) : ;; *) echo "boton invalido o reservado: '$BTN' (lista v1.1.0; magic_mapper_settings esta reservado)"; exit 2;; esac
VERSION="v1.1.0"
BASE="https://raw.githubusercontent.com/andrewfraley/magic_mapper/$VERSION"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)

O1=$(echo "$LAPTOP" | cut -d. -f1); O2=$(echo "$LAPTOP" | cut -d. -f2)
O3=$(echo "$LAPTOP" | cut -d. -f3); O4=$(echo "$LAPTOP" | cut -d. -f4)
[ "$(echo "$LAPTOP" | awk -F. '{print NF}')" = "4" ] || { echo "IP debe tener 4 octetos: $LAPTOP"; exit 1; }
for o in "$O1" "$O2" "$O3" "$O4"; do
  case "$o" in ''|*[!0-9]*) echo "octeto no numerico: $o"; exit 1;; esac
  [ "$o" -le 255 ] || { echo "octeto fuera de rango: $o"; exit 1; }
done
PRIVATE=0
[ "$O1" = "192" ] && [ "$O2" = "168" ] && PRIVATE=1
[ "$O1" = "10" ] && PRIVATE=1
[ "$O1" = "172" ] && [ "$O2" -ge 16 ] && [ "$O2" -le 31 ] && PRIVATE=1
[ "$O1" = "100" ] && [ "$O2" -ge 64 ] && [ "$O2" -le 127 ] && PRIVATE=1
[ "$PRIVATE" = "1" ] || { echo "IP no privada/tailnet: $LAPTOP"; exit 1; }

curl -fsS -m 3 "http://$LAPTOP:8765/tv/button-health" >/dev/null 2>&1 \
  || { echo "listener :8765/tv/button-health NO responde en $LAPTOP - despliega primero la PR del listener"; exit 2; }

CFG="/tmp/mm-config-$$.json"
sed -e "s|__ASISTENTA_URL__|http://$LAPTOP:8765/tv/button|" -e "s|\"__BUTTON__\"|\"$BTN\"|" \
  "$SCRIPT_DIR/../../config/tv/magic_mapper_config.json" > "$CFG"
python3 -m json.tool "$CFG" >/dev/null || { echo "config no es JSON valido"; rm -f "$CFG"; exit 1; }
python3 -c "import json;d=json.load(open('$CFG'));assert '$BTN' in d" || { rm -f "$CFG"; exit 1; }

ssh "$USER@$TV" sh -s "$BASE" <<'REMOTE_EOF'
set -eu
BASE="$1"
mkdir -p /var/lib/webosbrew/init.d
command -v python3 >/dev/null || { echo "python3 no existe en la TV"; exit 1; }
command -v pgrep >/dev/null || { echo "pgrep no existe en la TV (lo exigen deploy y rollback)"; exit 1; }
python3 -c 'import evdev' 2>/dev/null || { echo "python-evdev no importable en la TV"; exit 1; }
[ -d /dev/input ] || { echo "/dev/input ausente"; exit 1; }
rm -rf /home/root/.mm-new && mkdir -p /home/root/.mm-new
cd /home/root/.mm-new
wget -q "$BASE/magic_mapper.py" -O magic_mapper.py
wget -q "$BASE/magic_mapper_config.json" -O magic_mapper_config.json.dist
wget -q "$BASE/start_magic_mapper" -O start_magic_mapper
[ -s magic_mapper.py ] || { echo "magic_mapper.py vacio/ausente"; exit 1; }
[ -s magic_mapper_config.json.dist ] || { echo "config dist vacio/ausente"; exit 1; }
[ -s start_magic_mapper ] || { echo "start_magic_mapper vacio/ausente"; exit 1; }
python3 -c "import ast; ast.parse(open('/home/root/.mm-new/magic_mapper.py').read())"
SHBIN=$(head -1 start_magic_mapper | tr -d '\r' | sed 's/^#!//')
[ -x "$SHBIN" ] || { echo "interprete $SHBIN no existe en la TV"; exit 1; }
"$SHBIN" -n start_magic_mapper || { echo "start_magic_mapper no parsea con $SHBIN"; exit 1; }
mv /home/root/.mm-new/start_magic_mapper /var/lib/webosbrew/init.d/.start_magic_mapper.staged
REMOTE_EOF
ssh "$USER@$TV" "cat > /home/root/.mm-new/magic_mapper_config.json" < "$CFG"
rm -f "$CFG"
ssh "$USER@$TV" "python3 -m json.tool /home/root/.mm-new/magic_mapper_config.json >/dev/null"

scp "$SCRIPT_DIR/templates/mapper-rollback.sh" "$USER@$TV:/home/root/.mm-rollback.tmpl"
ssh "$USER@$TV" sh -s <<'REMOTE_EOF'
set -eu
TS=$(date +%Y%m%d-%H%M%S)
BK=/home/root/mm-backup-$TS
FILES="/home/root/magic_mapper.py /home/root/magic_mapper_config.json /home/root/magic_mapper_config.json.dist /var/lib/webosbrew/init.d/start_magic_mapper"
mkdir -p "$BK"
for f in $FILES; do
  if [ -e "$f" ]; then cp -a "$f" "$BK/"; fi
done
# Rollback REAL generado desde el template testeado (templates/mapper-rollback.sh):
# stop sin ||true, guard no-vivo antes de rm, restore con fallos visibles.
sed "s|__BK__|$BK|g" /home/root/.mm-rollback.tmpl > /home/root/mm-rollback-$TS.sh
chmod +x /home/root/mm-rollback-$TS.sh
[ -x /home/root/mm-rollback-$TS.sh ] || { echo "rollback script NO creado - aborto ANTES de mutar"; exit 1; }
rollback() {
  echo "FALLO - ROLLBACK AUTOMATICO"
  if ! sh /home/root/mm-rollback-$TS.sh; then echo "EL ROLLBACK TAMBIEN FALLO: restaurar a mano desde $BK"; fi
  exit 1
}
# Stop confirmado no-vivo ANTES de mutar (tambien sin init: proceso huerfano).
if [ -x /var/lib/webosbrew/init.d/start_magic_mapper ]; then
  /var/lib/webosbrew/init.d/start_magic_mapper stop 2>/dev/null || true
fi
sleep 1
pgrep -f magic_mapper.py >/dev/null 2>&1 && { echo "un magic_mapper viejo sigue VIVO - aborto ANTES de mutar"; exit 1; }
mv /home/root/.mm-new/magic_mapper.py /home/root/magic_mapper.py || rollback
mv /home/root/.mm-new/magic_mapper_config.json /home/root/magic_mapper_config.json || rollback
mv /home/root/.mm-new/magic_mapper_config.json.dist /home/root/magic_mapper_config.json.dist || rollback
mv /var/lib/webosbrew/init.d/.start_magic_mapper.staged /var/lib/webosbrew/init.d/start_magic_mapper || rollback
chmod +x /var/lib/webosbrew/init.d/start_magic_mapper || rollback
rm -rf /home/root/.mm-new
/var/lib/webosbrew/init.d/start_magic_mapper start || rollback
sleep 2
pgrep -f magic_mapper.py >/dev/null 2>&1 || rollback
echo "magic_mapper: DESPLEGADO Y PROCESO VIVO"
echo "Backup: $BK | Rollback manual: sh /home/root/mm-rollback-$TS.sh"
REMOTE_EOF
